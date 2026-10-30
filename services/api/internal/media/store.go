package media

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type Object struct {
	Bytes       []byte
	ContentType string
}

type Store interface {
	Put(context.Context, string, []byte, string) error
	Get(context.Context, string) (Object, error)
	Delete(context.Context, string) error
}

type S3Store struct {
	bucket string
	client *s3.Client
}

type UnavailableStore struct{ err error }

func (s UnavailableStore) Put(context.Context, string, []byte, string) error { return s.err }
func (s UnavailableStore) Get(context.Context, string) (Object, error)       { return Object{}, s.err }
func (s UnavailableStore) Delete(context.Context, string) error              { return s.err }

func NewStoreFromEnv() Store {
	store, err := NewS3Store(
		firstNonEmpty(os.Getenv("RAVEN_MEDIA_S3_ENDPOINT"), os.Getenv("S3_ENDPOINT"), os.Getenv("S3_HOST")),
		firstNonEmpty(os.Getenv("RAVEN_MEDIA_S3_BUCKET"), os.Getenv("S3_BUCKET")),
		firstNonEmpty(os.Getenv("RAVEN_MEDIA_S3_REGION"), os.Getenv("S3_REGION"), "us-east-1"),
		firstNonEmpty(os.Getenv("RAVEN_MEDIA_S3_ACCESS_KEY"), os.Getenv("S3_ACCESS_KEY")),
		firstNonEmpty(os.Getenv("RAVEN_MEDIA_S3_SECRET_KEY"), os.Getenv("S3_SECRET_KEY")),
		parseBoolDefault(firstNonEmpty(os.Getenv("RAVEN_MEDIA_S3_PATH_STYLE"), os.Getenv("S3_PATH_STYLE")), true),
	)
	if err != nil {
		return UnavailableStore{err: err}
	}
	return store
}

func NewS3Store(endpoint, bucket, region, accessKey, secretKey string, pathStyle bool) (*S3Store, error) {
	endpoint = strings.TrimSpace(endpoint)
	bucket = strings.Trim(strings.TrimSpace(bucket), "/")
	accessKey = strings.TrimSpace(accessKey)
	if endpoint == "" || bucket == "" || accessKey == "" || strings.TrimSpace(secretKey) == "" {
		return nil, errors.New("profile image storage is not configured")
	}
	if !strings.Contains(endpoint, "://") {
		endpoint = "https://" + endpoint
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("profile image storage endpoint is invalid")
	}
	if strings.TrimSpace(region) == "" {
		region = "us-east-1"
	}
	cfg, err := config.LoadDefaultConfig(
		context.Background(),
		config.WithRegion(strings.TrimSpace(region)),
		config.WithBaseEndpoint(strings.TrimRight(parsed.String(), "/")),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
		config.WithHTTPClient(&http.Client{Timeout: 20 * time.Second}),
	)
	if err != nil {
		return nil, errors.New("profile image storage configuration is invalid")
	}
	client := s3.NewFromConfig(cfg, func(options *s3.Options) { options.UsePathStyle = pathStyle })
	return &S3Store{bucket: bucket, client: client}, nil
}

func (s *S3Store) Put(ctx context.Context, key string, body []byte, contentType string) error {
	key, err := validKey(key)
	if err != nil {
		return err
	}
	_, err = s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(body),
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return errors.New("profile image could not be stored")
	}
	return nil
}

func (s *S3Store) Get(ctx context.Context, key string) (Object, error) {
	key, err := validKey(key)
	if err != nil {
		return Object{}, err
	}
	result, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		return Object{}, errors.New("profile image is unavailable")
	}
	defer result.Body.Close()
	body, err := io.ReadAll(io.LimitReader(result.Body, 10*1024*1024+1))
	if err != nil || len(body) > 10*1024*1024 {
		return Object{}, errors.New("profile image could not be read")
	}
	return Object{Bytes: body, ContentType: aws.ToString(result.ContentType)}, nil
}

func (s *S3Store) Delete(ctx context.Context, key string) error {
	key, err := validKey(key)
	if err != nil {
		return err
	}
	_, err = s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		return errors.New("profile image could not be removed")
	}
	return nil
}

func validKey(value string) (string, error) {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	if value == "" || strings.HasPrefix(value, "/") || strings.Contains(value, "../") || strings.Contains(value, "/..") {
		return "", errors.New("profile image object key is invalid")
	}
	return value, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func parseBoolDefault(value string, fallback bool) bool {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(strings.TrimSpace(value))
	if err != nil {
		return fallback
	}
	return parsed
}
