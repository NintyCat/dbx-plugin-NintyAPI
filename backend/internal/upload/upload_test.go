package upload

import (
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/rest"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

// upload sends body in chunks the way the workbench does, and returns the id.
func upload(t *testing.T, store *Store, name string, body string, chunk int) string {
	t.Helper()
	item, err := store.Begin(name, "text/plain", int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	for offset := 0; offset < len(body); offset += chunk {
		end := min(offset+chunk, len(body))
		written, err := store.Append(item.ID, int64(offset), []byte(body[offset:end]))
		if err != nil {
			t.Fatal(err)
		}
		if written != int64(end) {
			t.Fatalf("written = %d, want %d", written, end)
		}
	}
	return item.ID
}

func read(t *testing.T, store *Store, id string) string {
	t.Helper()
	reader, err := store.Open(rest.FileRef{ID: id})
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

// The round trip the whole package exists for: bytes in chunks, bytes back out.
func TestChunksReassembleInOrder(t *testing.T) {
	store := newStore(t)
	body := strings.Repeat("abcdefghij", 250) // 2500 bytes, not a chunk multiple
	id := upload(t, store, "big.txt", body, 256)
	if got := read(t, store, id); got != body {
		t.Fatalf("round trip = %d bytes, want %d", len(got), len(body))
	}
}

func TestEmptyFileRoundTrips(t *testing.T) {
	store := newStore(t)
	id := upload(t, store, "empty.txt", "", 256)
	if got := read(t, store, id); got != "" {
		t.Fatalf("round trip = %q, want empty", got)
	}
}

// A chunk that arrives out of order means one was lost or replayed. Accepting
// it would silently corrupt the file, so the store refuses it.
func TestOutOfOrderChunkIsRejected(t *testing.T) {
	store := newStore(t)
	item, err := store.Begin("a.txt", "text/plain", 8)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append(item.ID, 0, []byte("abcd")); err != nil {
		t.Fatal(err)
	}
	_, err = store.Append(item.ID, 0, []byte("abcd"))
	if err == nil {
		t.Fatal("a replayed chunk must be refused")
	}
	if !strings.Contains(err.Error(), "顺序") {
		t.Fatalf("error = %v, want it to name the ordering", err)
	}
}

func TestOversizedFileIsRefusedUpFront(t *testing.T) {
	store := newStore(t)
	_, err := store.Begin("huge.bin", "application/octet-stream", MaxFileBytes+1)
	if err == nil {
		t.Fatal("a file over the cap must be refused before any chunk travels")
	}
	if !strings.Contains(err.Error(), "超过") {
		t.Fatalf("error = %v, want it to name the cap", err)
	}
}

// A declared size is only a hint — the running total is what actually holds the
// line, so a client that understates the size still cannot exceed the cap.
func TestChunksCannotGrowPastTheCap(t *testing.T) {
	store := newStore(t)
	item, err := store.Begin("sneaky.bin", "application/octet-stream", 0)
	if err != nil {
		t.Fatal(err)
	}
	// Standing the counter at the cap is how a long series of accepted chunks
	// would leave it, without writing 64 MiB to disk to get there.
	store.mu.Lock()
	store.items[item.ID].Written = MaxFileBytes
	store.mu.Unlock()
	if _, err := store.Append(item.ID, MaxFileBytes, []byte("x")); err == nil {
		t.Fatal("a chunk past the cap must be refused")
	}
}

func TestOversizedChunkIsRefused(t *testing.T) {
	store := newStore(t)
	item, err := store.Begin("a.bin", "application/octet-stream", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append(item.ID, 0, make([]byte, MaxChunkBytes+1)); err == nil {
		t.Fatal("a chunk over the cap must be refused")
	}
}

// Sending half a file is worse than failing: the server would store a truncated
// upload and report success.
func TestIncompleteUploadCannotBeSent(t *testing.T) {
	store := newStore(t)
	item, err := store.Begin("a.txt", "text/plain", 10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append(item.ID, 0, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	_, err = store.Open(rest.FileRef{ID: item.ID})
	if err == nil {
		t.Fatal("a partial upload must not be sendable")
	}
	if !strings.Contains(err.Error(), "不完整") {
		t.Fatalf("error = %v, want it to say the upload is incomplete", err)
	}
}

func TestUnknownUploadIsRefused(t *testing.T) {
	store := newStore(t)
	_, err := store.Open(rest.FileRef{ID: "nope"})
	if err == nil {
		t.Fatal("an unknown upload must not open")
	}
	if !strings.Contains(err.Error(), "不存在") {
		t.Fatalf("error = %v, want it to say the file is gone", err)
	}
}

// A cancelled send must not leave the file on disk for the whole TTL.
func TestDropRemovesTheFile(t *testing.T) {
	store := newStore(t)
	id := upload(t, store, "a.txt", "hello", 256)
	store.Drop(id)
	if store.Len() != 0 {
		t.Fatalf("store still holds %d uploads", store.Len())
	}
	if _, err := store.Open(rest.FileRef{ID: id}); err == nil {
		t.Fatal("a dropped upload must not open")
	}
	assertEmptyDir(t, store.Dir())
}

// An abandoned pick is cleaned up on the next Begin rather than by a timer.
func TestExpiredUploadsAreSweptOnBegin(t *testing.T) {
	store := newStore(t)
	id := upload(t, store, "old.txt", "hello", 256)
	store.now = func() time.Time { return time.Now().Add(ttl + time.Minute) }
	if _, err := store.Begin("new.txt", "text/plain", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Open(rest.FileRef{ID: id}); err == nil {
		t.Fatal("an expired upload must not open")
	}
	if store.Len() != 1 {
		t.Fatalf("store holds %d uploads, want only the new one", store.Len())
	}
}

func TestExpiredUploadIsRefusedOnAppend(t *testing.T) {
	store := newStore(t)
	item, err := store.Begin("a.txt", "text/plain", 4)
	if err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return time.Now().Add(ttl + time.Minute) }
	if _, err := store.Append(item.ID, 0, []byte("abcd")); err == nil {
		t.Fatal("an expired upload must not accept more chunks")
	}
}

func TestCloseRemovesEverything(t *testing.T) {
	dir := t.TempDir()
	store, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	upload(t, store, "a.txt", "hello", 256)
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("upload directory survived Close: %v", err)
	}
}

func assertEmptyDir(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("directory still holds %v", names)
	}
}
