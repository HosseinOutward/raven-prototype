package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

type objectClient interface {
	HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
}

type config struct {
	bucket string
	client objectClient
}

type result struct {
	Action string `json:"action"`
	Key    string `json:"key"`
	Exists *bool  `json:"exists,omitempty"`
	Size   int64  `json:"size,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("command is required: exists, put, head, or verify")
	}
	cfg, err := configFromEnv()
	if err != nil {
		return err
	}
	command := strings.ToLower(args[0])
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	key := flags.String("key", "", "")
	file := flags.String("file", "", "")
	if err := flags.Parse(args[1:]); err != nil {
		return errors.New("invalid command arguments")
	}
	if err := validateKey(*key); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	var output result
	switch command {
	case "exists":
		info, exists, err := cfg.head(ctx, *key)
		if err != nil {
			return err
		}
		output = info
		output.Action = command
		output.Exists = &exists
	case "head":
		info, exists, err := cfg.head(ctx, *key)
		if err != nil {
			return err
		}
		if !exists {
			return errors.New("object does not exist")
		}
		output = info
		output.Action = command
	case "put":
		if strings.TrimSpace(*file) == "" {
			return errors.New("file is required")
		}
		output, err = cfg.put(ctx, *key, *file)
		if err != nil {
			return err
		}
	case "verify":
		if strings.TrimSpace(*file) == "" {
			return errors.New("file is required")
		}
		output, err = cfg.verify(ctx, *key, *file)
		if err != nil {
			return err
		}
	default:
		return errors.New("unknown command")
	}
	encoded, err := json.Marshal(output)
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}

func configFromEnv() (*config, error) {
	endpoint := first(os.Getenv("S3_ENDPOINT"), os.Getenv("S3_HOST"))
	if endpoint == "" {
		return nil, errors.New("S3_ENDPOINT or S3_HOST is required")
	}
	if !strings.Contains(endpoint, "://") {
		endpoint = "https://" + endpoint
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("S3 endpoint is invalid")
	}
	bucket := strings.Trim(strings.TrimSpace(os.Getenv("S3_BUCKET")), "/")
	accessKey := strings.TrimSpace(os.Getenv("S3_ACCESS_KEY"))
	secretKey := os.Getenv("S3_SECRET_KEY")
	if bucket == "" || accessKey == "" || secretKey == "" {
		return nil, errors.New("S3_BUCKET, S3_ACCESS_KEY, and S3_SECRET_KEY are required")
	}
	region := first(os.Getenv("S3_REGION"), "us-east-1")
	pathStyle := true
	if raw := strings.TrimSpace(os.Getenv("S3_PATH_STYLE")); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return nil, errors.New("S3_PATH_STYLE must be true or false")
		}
		pathStyle = value
	}
	awsConfig := aws.Config{
		Region:      region,
		Credentials: aws.NewCredentialsCache(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
		HTTPClient:  &http.Client{Timeout: 30 * time.Minute},
	}
	client := s3.NewFromConfig(awsConfig, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(parsed.String())
		options.UsePathStyle = pathStyle
	})
	return &config{bucket: bucket, client: client}, nil
}

func (c *config) head(ctx context.Context, key string) (result, bool, error) {
	output, err := c.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(c.bucket), Key: aws.String(key)})
	if err != nil {
		var responseError *smithyhttp.ResponseError
		if errors.As(err, &responseError) && responseError.HTTPStatusCode() == http.StatusNotFound {
			return result{Key: key}, false, nil
		}
		return result{}, false, errors.New("S3 HEAD request failed")
	}
	size := aws.ToInt64(output.ContentLength)
	if size < 0 {
		return result{}, false, errors.New("S3 HEAD returned an invalid size")
	}
	return result{Key: key, Size: size, SHA256: strings.ToLower(strings.TrimSpace(output.Metadata["sha256"]))}, true, nil
}

func (c *config) put(ctx context.Context, key, filePath string) (result, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return result{}, errors.New("artifact file could not be opened")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return result{}, errors.New("artifact path is not a regular file")
	}
	hash, err := hashFile(file)
	if err != nil {
		return result{}, errors.New("artifact hash could not be calculated")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return result{}, errors.New("artifact file could not be rewound")
	}
	_, err = c.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(c.bucket),
		Key:           aws.String(key),
		Body:          file,
		ContentLength: aws.Int64(info.Size()),
		IfNoneMatch:   aws.String("*"),
		Metadata:      map[string]string{"sha256": hash},
	})
	if err != nil {
		var responseError *smithyhttp.ResponseError
		if errors.As(err, &responseError) && (responseError.HTTPStatusCode() == http.StatusPreconditionFailed || responseError.HTTPStatusCode() == http.StatusConflict) {
			return result{}, errors.New("immutable object already exists")
		}
		return result{}, errors.New("S3 upload request failed")
	}
	return result{Action: "put", Key: key, Size: info.Size(), SHA256: hash}, nil
}

func (c *config) verify(ctx context.Context, key, filePath string) (result, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return result{}, errors.New("local artifact could not be opened")
	}
	localHash, err := hashFile(file)
	_ = file.Close()
	if err != nil {
		return result{}, errors.New("local artifact hash could not be calculated")
	}
	localInfo, err := os.Stat(filePath)
	if err != nil {
		return result{}, errors.New("local artifact metadata could not be read")
	}
	remote, exists, err := c.head(ctx, key)
	if err != nil {
		return result{}, err
	}
	if !exists {
		return result{}, errors.New("uploaded object is missing")
	}
	if remote.Size != localInfo.Size() {
		return result{}, errors.New("uploaded object size does not match")
	}
	if remote.SHA256 == "" || remote.SHA256 != localHash {
		return result{}, errors.New("uploaded object metadata hash does not match")
	}
	output, err := c.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(c.bucket), Key: aws.String(key)})
	if err != nil {
		return result{}, errors.New("S3 verification download failed")
	}
	defer output.Body.Close()
	digest := sha256.New()
	size, err := io.Copy(digest, output.Body)
	if err != nil {
		return result{}, errors.New("S3 verification download was interrupted")
	}
	if size != localInfo.Size() || hex.EncodeToString(digest.Sum(nil)) != localHash {
		return result{}, errors.New("downloaded object content does not match")
	}
	return result{Action: "verify", Key: key, Size: size, SHA256: localHash}, nil
}

func hashFile(file *os.File) (string, error) {
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func validateKey(key string) error {
	key = strings.TrimSpace(strings.ReplaceAll(key, "\\", "/"))
	if key == "" || strings.HasPrefix(key, "/") || strings.Contains(key, "//") {
		return errors.New("object key is invalid")
	}
	for _, segment := range strings.Split(key, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return errors.New("object key is invalid")
		}
	}
	return nil
}

func first(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
