// Package upload holds the bytes of files the workbench picked, in the window
// between the calls that deliver them and the request that sends them.
//
// The workbench UI runs in a sandboxed iframe: a picked file is a browser File
// with no path on disk, and the host bridge caps a single JSON parameter at
// 2 MiB. A file therefore reaches the sidecar only as bytes, in chunks, and
// this store reassembles them on disk so a request can stream them back out.
package upload

import (
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/rest"
	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/store"
)

const (
	// MaxFileBytes caps one upload. The bytes land on disk and are then read
	// back into the request body, so this bounds memory as much as disk.
	MaxFileBytes = 64 << 20
	// MaxChunkBytes is the largest slice Append accepts. The workbench sends
	// well under this; the cap is what stops a malformed offset from asking the
	// decoder for unbounded memory.
	MaxChunkBytes = 4 << 20
	// ttl is how long an upload survives without being consumed. Files are sent
	// moments after they are picked, so this only has to outlive a slow request
	// or a user who picked a file and walked away.
	ttl = 30 * time.Minute
)

// Item is one uploaded file. Written counts the bytes received so far, which is
// what the workbench compares against its own offset to detect a lost chunk.
type Item struct {
	ID          string
	Name        string
	ContentType string
	Size        int64
	Written     int64
}

// Store keeps uploads in a private temporary directory. It is safe for
// concurrent use: the workbench can have several requests in flight.
type Store struct {
	dir   string
	mu    sync.Mutex
	items map[string]*entry
	now   func() time.Time
}

// entry is an Item plus what only the store needs: the open write handle, the
// path it writes to, and when the file stops being worth keeping.
type entry struct {
	Item
	path    string
	file    *os.File
	expires time.Time
}

// New creates a store backed by its own temporary directory. An empty dir lets
// the OS pick one; the store removes whatever it created on Close.
func New(dir string) (*Store, error) {
	if dir == "" {
		created, err := os.MkdirTemp("", "nintyapi-upload-")
		if err != nil {
			return nil, err
		}
		dir = created
	} else if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir, items: map[string]*entry{}, now: time.Now}, nil
}

// Begin opens a slot for a file the workbench is about to send. The declared
// size is advisory — it is checked against the cap up front so an oversized
// file fails before a single chunk travels, and the running total is checked
// again on every Append.
func (s *Store) Begin(name, contentType string, size int64) (*Item, error) {
	if size < 0 {
		return nil, errors.New("上传的文件大小无效")
	}
	if size > MaxFileBytes {
		return nil, fmt.Errorf("上传的文件超过 %d MiB", MaxFileBytes>>20)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	file, err := os.CreateTemp(s.dir, "up-*.part")
	if err != nil {
		return nil, err
	}
	item := &entry{
		Item: Item{
			ID:          store.NewID(),
			Name:        name,
			ContentType: contentType,
			Size:        size,
		},
		path:    file.Name(),
		file:    file,
		expires: s.now().Add(ttl),
	}
	s.items[item.ID] = item
	out := item.Item
	return &out, nil
}

// Append writes the next slice of a file. Chunks must arrive in order: the
// workbench sends them from a single loop, so an offset that does not match
// what has been written means a chunk was lost or replayed, and refusing it
// keeps a corrupted upload from being sent as if it were intact.
func (s *Store) Append(id string, offset int64, data []byte) (int64, error) {
	if len(data) > MaxChunkBytes {
		return 0, fmt.Errorf("上传分片超过 %d MiB", MaxChunkBytes>>20)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	item, err := s.liveLocked(id)
	if err != nil {
		return 0, err
	}
	if offset != item.Written {
		return 0, fmt.Errorf("上传分片顺序错误：期望偏移 %d，收到 %d", item.Written, offset)
	}
	if item.Written+int64(len(data)) > MaxFileBytes {
		return 0, fmt.Errorf("上传的文件超过 %d MiB", MaxFileBytes>>20)
	}
	if _, err := item.file.Write(data); err != nil {
		return 0, err
	}
	item.Written += int64(len(data))
	item.expires = s.now().Add(ttl)
	return item.Written, nil
}

// Open hands the assembled bytes to the sender. It satisfies rest.FileResolver,
// which is how a request body reaches a file the workbench picked.
func (s *Store) Open(ref rest.FileRef) (io.ReadCloser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, err := s.liveLocked(ref.ID)
	if err != nil {
		return nil, err
	}
	if item.Size > 0 && item.Written != item.Size {
		return nil, fmt.Errorf("文件 %q 上传不完整，请重新选择", item.Name)
	}
	// The write handle buffers nothing, but a Sync makes the bytes visible to
	// the read handle on every platform before it is opened.
	if err := item.file.Sync(); err != nil {
		return nil, err
	}
	return os.Open(item.path)
}

// Drop discards an upload the workbench abandoned, so a cancelled send does not
// leave a file on disk for the whole TTL.
func (s *Store) Drop(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropLocked(id)
}

// Close removes every upload and the directory that held them.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range s.items {
		s.dropLocked(id)
	}
	return os.RemoveAll(s.dir)
}

// liveLocked finds an upload that has not expired. The message is the one the
// user acts on: the workbench drops its own copy of the file when a tab closes,
// so the only fix is picking it again.
func (s *Store) liveLocked(id string) (*entry, error) {
	if id == "" {
		return nil, errors.New("上传的文件不存在或已过期，请重新选择文件")
	}
	item, ok := s.items[id]
	if !ok {
		return nil, errors.New("上传的文件不存在或已过期，请重新选择文件")
	}
	if s.now().After(item.expires) {
		s.dropLocked(id)
		return nil, errors.New("上传的文件不存在或已过期，请重新选择文件")
	}
	return item, nil
}

func (s *Store) dropLocked(id string) {
	item, ok := s.items[id]
	if !ok {
		return
	}
	delete(s.items, id)
	item.file.Close()
	os.Remove(item.path)
}

// sweepLocked clears uploads that outlived their TTL. It runs on Begin, which
// is the only moment a new file can arrive, so an idle plugin holds no files
// and no timer has to be kept alive.
func (s *Store) sweepLocked() {
	now := s.now()
	for id, item := range s.items {
		if now.After(item.expires) {
			s.dropLocked(id)
		}
	}
}

// Dir reports the directory holding the uploads. Tests use it to assert that a
// dropped or expired upload left nothing behind.
func (s *Store) Dir() string { return s.dir }

// Len reports how many uploads are currently held.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.items)
}
