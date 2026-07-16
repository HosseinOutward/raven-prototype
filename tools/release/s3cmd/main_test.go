package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func TestValidateKey(t *testing.T) {
	for _, value := range []string{"desktop/alpha/0.2.0/windows/x86_64/raven.exe", "a-b/c_d.json"} {
		if err := validateKey(value); err != nil {
			t.Fatalf("valid key rejected: %s", value)
		}
	}
	for _, value := range []string{"", "/root", "a//b", "a/../b", "a/./b"} {
		if err := validateKey(value); err == nil {
			t.Fatalf("invalid key accepted: %s", value)
		}
	}
}

func TestPutAndVerify(t *testing.T) {
	content := []byte("raven immutable artifact")
	hash := hashBytes(content)
	var stored []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
			t.Errorf("authorization missing")
		}
		if r.URL.Path != "/raven/desktop/alpha/0.2.0/artifact.bin" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		switch r.Method {
		case http.MethodPut:
			if r.Header.Get("If-None-Match") != "*" || r.Header.Get("X-Amz-Meta-Sha256") != hash {
				t.Errorf("immutable upload headers missing")
			}
			stored, _ = io.ReadAll(r.Body)
			w.WriteHeader(http.StatusOK)
		case http.MethodHead:
			if stored == nil {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Length", "24")
			w.Header().Set("X-Amz-Meta-Sha256", hash)
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			w.Header().Set("Content-Length", "24")
			_, _ = w.Write(stored)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()
	awsConfig := aws.Config{
		Region:      "us-east-1",
		Credentials: aws.NewCredentialsCache(credentials.NewStaticCredentialsProvider("access", "secret", "")),
		HTTPClient:  server.Client(),
	}
	client := s3.NewFromConfig(awsConfig, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(server.URL)
		options.UsePathStyle = true
	})
	cfg := &config{bucket: "raven", client: client}
	dir := t.TempDir()
	file := filepath.Join(dir, "artifact.bin")
	if err := os.WriteFile(file, content, 0600); err != nil {
		t.Fatal(err)
	}
	put, err := cfg.put(context.Background(), "desktop/alpha/0.2.0/artifact.bin", file)
	if err != nil {
		t.Fatal(err)
	}
	if put.SHA256 != hash || put.Size != int64(len(content)) {
		t.Fatalf("unexpected put result: %+v", put)
	}
	verified, err := cfg.verify(context.Background(), "desktop/alpha/0.2.0/artifact.bin", file)
	if err != nil {
		t.Fatal(err)
	}
	if verified.SHA256 != hash || verified.Size != int64(len(content)) {
		t.Fatalf("unexpected verify result: %+v", verified)
	}
}

func hashBytes(value []byte) string {
	file, err := os.CreateTemp("", "raven-hash-test")
	if err != nil {
		panic(err)
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(value); err != nil {
		panic(err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		panic(err)
	}
	hash, err := hashFile(file)
	_ = file.Close()
	if err != nil {
		panic(err)
	}
	return hash
}
