package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// DefaultPath returns the shared config file path for this plugin. Data is
// keyed per connection inside each file, matching DBX's secret-store model.
func DefaultPath(name string) (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "dbx-plugin-nintyapi", name), nil
}

// Load reads a JSON file; a missing file is not an error and leaves v untouched.
func Load(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return json.Unmarshal(data, v)
}

// Save writes JSON atomically: temp file in the same directory, fsync, chmod,
// rename. Callers commit to memory only after Save returns nil.
func Save(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), "store-*.tmp")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if ce := file.Close(); err == nil {
		err = ce
	}
	if err == nil {
		err = os.Chmod(name, 0600)
	}
	if err == nil {
		err = os.Rename(name, path)
	}
	return err
}

// NewID returns a random 16-character hex identifier.
func NewID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(buf)
}
