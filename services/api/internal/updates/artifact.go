package updates

import (
	"context"
	"errors"
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

type S3ArtifactStore struct {
	bucket    string
	client    *s3.Client
	presigner *s3.PresignClient
}

type UnavailableArtifactStore struct {
	err error
}

func (s UnavailableArtifactStore) PresignGet(context.Context, string, time.Duration) (string, error) {
	return "", s.err
}

func (s UnavailableArtifactStore) Head(context.Context, string) (ObjectInfo, error) {
	return ObjectInfo{}, s.err
}

func NewArtifactStoreFromEnv() ArtifactStore {
	store, err := NewS3ArtifactStore(
		firstNonEmpty(os.Getenv("S3_ENDPOINT"), os.Getenv("S3_HOST")),
		os.Getenv("S3_BUCKET"),
		firstNonEmpty(os.Getenv("S3_REGION"), "us-east-1"),
		os.Getenv("S3_ACCESS_KEY"),
		os.Getenv("S3_SECRET_KEY"),
		parseBoolDefault(os.Getenv("S3_PATH_STYLE"), true),
	)
	if err != nil {
		return UnavailableArtifactStore{err: err}
	}
	return store
}

func NewS3ArtifactStore(endpoint, bucket, region, accessKey, secretKey string, pathStyle bool) (*S3ArtifactStore, error) {
	endpoint = strings.TrimSpace(endpoint)
	bucket = strings.Trim(strings.TrimSpace(bucket), "/")
	accessKey = strings.TrimSpace(accessKey)
	if endpoint == "" || bucket == "" || accessKey == "" || strings.TrimSpace(secretKey) == "" {
		return nil, errors.New("artifact storage is not configured")
	}
	if !strings.Contains(endpoint, "://") {
		endpoint = "https://" + endpoint
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("artifact storage endpoint is invalid")
	}
	endpoint = strings.TrimRight(parsed.String(), "/")
	region = strings.TrimSpace(region)
	if region == "" {
		region = "us-east-1"
	}
	cfg, err := config.LoadDefaultConfig(
		context.Background(),
		config.WithRegion(region),
		config.WithBaseEndpoint(endpoint),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
		config.WithHTTPClient(&http.Client{Timeout: 15 * time.Second}),
	)
	if err != nil {
		return nil, errors.New("artifact storage configuration is invalid")
	}
	client := s3.NewFromConfig(cfg, func(options *s3.Options) {
		options.UsePathStyle = pathStyle
	})
	return &S3ArtifactStore{bucket: bucket, client: client, presigner: s3.NewPresignClient(client)}, nil
}

func (s *S3ArtifactStore) PresignGet(ctx context.Context, objectKey string, expiry time.Duration) (string, error) {
	objectKey, err := validObjectKey(objectKey)
	if err != nil {
		return "", err
	}
	if expiry <= 0 || expiry > 24*time.Hour {
		expiry = 10 * time.Minute
	}
	result, err := s.presigner.PresignGetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(objectKey)}, s3.WithPresignExpires(expiry))
	if err != nil {
		return "", errors.New("artifact download URL could not be created")
	}
	return result.URL, nil
}

func (s *S3ArtifactStore) Head(ctx context.Context, objectKey string) (ObjectInfo, error) {
	objectKey, err := validObjectKey(objectKey)
	if err != nil {
		return ObjectInfo{}, err
	}
	result, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(objectKey)})
	if err != nil {
		return ObjectInfo{}, errors.New("artifact object is unavailable")
	}
	if result.ContentLength == nil || *result.ContentLength < 0 {
		return ObjectInfo{}, errors.New("artifact object returned an invalid size")
	}
	return ObjectInfo{Size: *result.ContentLength, SHA256: strings.ToLower(strings.TrimSpace(result.Metadata["sha256"]))}, nil
}

func validObjectKey(value string) (string, error) {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	if value == "" || strings.HasPrefix(value, "/") || strings.Contains(value, "../") || strings.Contains(value, "/..") {
		return "", errors.New("artifact object key is invalid")
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
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}
