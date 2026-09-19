package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	dbx "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

// settings holds one key/value bag per connection. Everything in here is
// UI-level state (active environment, panel sizes); anything secret belongs to
// the connection's secret binding and must never land in this file.
type settings struct {
	mu     sync.Mutex
	path   string
	loaded bool
	bags   map[string]map[string]string
}

// ensure locates and reads the backing file once per process. Tests preset
// path before the first call to point the store at a temp directory.
func (s *settings) ensure() error {
	if s.loaded {
		return nil
	}
	if s.path == "" {
		dir, err := os.UserConfigDir()
		if err != nil {
			return err
		}
		s.path = filepath.Join(dir, "dbx-plugin-nintyapi", "preferences.json")
	}
	s.bags = map[string]map[string]string{}
	if raw, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(raw, &s.bags)
	}
	s.loaded = true
	return nil
}

func (s *settings) bag(connID string) map[string]string {
	return s.bags[connID]
}

// put applies one key change (a nil value removes the key) and persists.
func (s *settings) put(connID, key string, value *string) error {
	bag := s.bags[connID]
	if value == nil {
		delete(bag, key)
	} else {
		if bag == nil {
			bag = map[string]string{}
			s.bags[connID] = bag
		}
		bag[key] = *value
	}
	return s.save()
}

func (s *settings) save() error {
	raw, err := json.Marshal(s.bags)
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".prefs-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	discard := func() {
		tmp.Close()
		os.Remove(name)
	}
	if _, err = tmp.Write(raw); err != nil {
		discard()
		return err
	}
	if err = tmp.Chmod(0o600); err != nil {
		discard()
		return err
	}
	if err = tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err = os.Rename(name, s.path); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}

// servePreferences answers ui/preferences-get and ui/preferences-set. Both
// verbs reply with the connection's current bag; a set with a null value
// removes the key.
func (p *plugin) servePreferences(method string, params map[string]any, raw json.RawMessage) (any, *dbx.PluginError) {
	connID, _ := params["connectionId"].(string)
	if strings.TrimSpace(connID) == "" {
		return nil, dbx.NewError(-32602, "缺少 connectionId")
	}
	s := &p.settings
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensure(); err != nil {
		return nil, toPluginError(err)
	}
	if method == "ui/preferences-set" {
		var req struct {
			Key   string  `json:"key"`
			Value *string `json:"value"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, dbx.NewError(-32602, "偏好参数无效")
		}
		if req.Key != "" {
			if err := s.put(connID, req.Key, req.Value); err != nil {
				return nil, toPluginError(err)
			}
		}
	}
	return map[string]any{"values": s.bag(connID)}, nil
}
