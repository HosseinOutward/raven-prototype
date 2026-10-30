package media

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestS3GetSupportsFullChatImagesAndBoundsReads(t *testing.T) {
	const limit = 10 * 1024 * 1024
	size := limit
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(make([]byte, size))
	}))
	defer server.Close()
	store, err := NewS3Store(server.URL, "test", "us-east-1", "test", "test", true)
	if err != nil {
		t.Fatal(err)
	}
	object, err := store.Get(context.Background(), "chat-attachments/full.png")
	if err != nil || len(object.Bytes) != limit {
		t.Fatalf("10 MiB image: bytes=%d err=%v", len(object.Bytes), err)
	}
	size++
	if _, err := store.Get(context.Background(), "chat-attachments/too-large.png"); err == nil {
		t.Fatal("accepted object beyond the read bound")
	}
}
