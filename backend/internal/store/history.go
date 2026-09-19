package store

import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/rest"
)

const (
	// maxEntries caps the per-connection history so the file stays small.
	maxEntries = 200
	// maxStoredBody caps each recorded request/response body. The whole file is
	// rewritten on every send, so one multi-megabyte body would slow down every
	// later request and balloon the file.
	maxStoredBody = 128 << 10
)

// Record is one sent request: the request as the workbench sent it, the
// response it got back, and when that happened. A body longer than
// maxStoredBody is cut down and flagged, so a reader can tell a short body
// from a shortened one.
type Record struct {
	ID                  string           `json:"id"`
	CreatedAt           time.Time        `json:"createdAt"`
	Request             rest.RequestSpec `json:"request"`
	Response            *rest.Response   `json:"response,omitempty"`
	RequestBodyOmitted  bool             `json:"requestBodyOmitted,omitempty"`
	ResponseBodyOmitted bool             `json:"responseBodyOmitted,omitempty"`
}

// Summary is one history row: enough to list a request without shipping the
// bodies it recorded.
type Summary struct {
	ID                  string    `json:"id"`
	Method              string    `json:"method"`
	URL                 string    `json:"url"`
	Status              int       `json:"status"`
	TimeMs              int64     `json:"timeMs"`
	Error               string    `json:"error,omitempty"`
	CreatedAt           time.Time `json:"createdAt"`
	ResponseBodyOmitted bool      `json:"responseBodyOmitted,omitempty"`
}

// Summary flattens a record for the list, preferring the URL the request
// actually reached so redirected and base-URL-relative calls stay honest.
func (r Record) Summary() Summary {
	s := Summary{
		ID:                  r.ID,
		CreatedAt:           r.CreatedAt,
		Method:              r.Request.Method,
		URL:                 r.Request.URL,
		ResponseBodyOmitted: r.ResponseBodyOmitted,
	}
	if r.Response != nil {
		s.Status = r.Response.Status
		s.TimeMs = r.Response.TimeMs
		s.Error = r.Response.Err
		if r.Response.URL != "" {
			s.URL = r.Response.URL
		}
	}
	return s
}

// Snapshot pairs a sent request with its response for storage. The response is
// copied before any trimming, so the caller can still render it in full.
func Snapshot(spec rest.RequestSpec, resp *rest.Response) Record {
	record := Record{CreatedAt: time.Now(), Request: spec}
	if spec.Body != nil && len(spec.Body.Content) > maxStoredBody {
		body := *spec.Body
		body.Content = cut(body.Content)
		record.Request.Body = &body
		record.RequestBodyOmitted = true
	}
	if resp == nil {
		return record
	}
	stored := *resp
	if len(stored.Body) > maxStoredBody {
		stored.Body = cut(stored.Body)
		stored.Truncated = true
		record.ResponseBodyOmitted = true
	}
	record.Response = &stored
	return record
}

// cut trims a body to the storage cap. Cutting mid-rune would leave a
// replacement character at the end of every shortened non-ASCII body.
func cut(text string) string {
	return strings.ToValidUTF8(text[:maxStoredBody], "")
}

// History persists recent requests per connection, newest first.
type History struct {
	mu    sync.Mutex
	path  string
	items map[string][]Record
}

// NewHistory targets an explicit file; an empty path falls back to the
// default user config location.
func NewHistory(path string) *History { return &History{path: path} }

// legacyEntry is the shape written before requests were recorded in full: the
// request line and the outcome, with no parameters or response.
type legacyEntry struct {
	ID        string    `json:"id"`
	Method    string    `json:"method"`
	URL       string    `json:"url"`
	Status    int       `json:"status"`
	TimeMs    int64     `json:"timeMs"`
	Error     string    `json:"error,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

func (h *History) ensure() error {
	if h.items != nil {
		return nil
	}
	if h.path == "" {
		path, err := DefaultPath("history.json")
		if err != nil {
			return err
		}
		h.path = path
	}
	raw := map[string][]json.RawMessage{}
	if err := Load(h.path, &raw); err != nil {
		return err
	}
	items := make(map[string][]Record, len(raw))
	for connID, list := range raw {
		for _, item := range list {
			var record Record
			if err := json.Unmarshal(item, &record); err == nil &&
				(record.Request.URL != "" || record.Request.Method != "") {
				items[connID] = append(items[connID], record)
				continue
			}
			// An entry from before the new shape: keep its identity so the row
			// still lists, minus the parameters it never stored.
			var legacy legacyEntry
			if err := json.Unmarshal(item, &legacy); err == nil {
				items[connID] = append(items[connID], Record{
					ID:        legacy.ID,
					CreatedAt: legacy.CreatedAt,
					Request:   rest.RequestSpec{Method: legacy.Method, URL: legacy.URL},
					Response: &rest.Response{
						Status: legacy.Status,
						TimeMs: legacy.TimeMs,
						Err:    legacy.Error,
						URL:    legacy.URL,
					},
				})
			}
		}
	}
	h.items = items
	return nil
}

func (h *History) List(connID string, limit int) ([]Summary, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.ensure(); err != nil {
		return nil, err
	}
	entries := h.items[connID]
	if limit <= 0 || limit > len(entries) {
		limit = len(entries)
	}
	out := make([]Summary, 0, limit)
	for _, entry := range entries[:limit] {
		out = append(out, entry.Summary())
	}
	return out, nil
}

// Get returns one recorded request in full.
func (h *History) Get(connID, id string) (Record, bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.ensure(); err != nil {
		return Record{}, false, err
	}
	for _, entry := range h.items[connID] {
		if entry.ID == id {
			return entry, true, nil
		}
	}
	return Record{}, false, nil
}

func (h *History) Add(connID string, entry Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.ensure(); err != nil {
		return err
	}
	if entry.ID == "" {
		entry.ID = NewID()
	}
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now()
	}
	next := make(map[string][]Record, len(h.items)+1)
	for k, v := range h.items {
		next[k] = v
	}
	entries := append([]Record{entry}, next[connID]...)
	if len(entries) > maxEntries {
		entries = entries[:maxEntries]
	}
	next[connID] = entries
	if err := Save(h.path, next); err != nil {
		return err
	}
	h.items = next
	return nil
}

func (h *History) Delete(connID, id string) ([]Summary, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.ensure(); err != nil {
		return nil, err
	}
	next := make(map[string][]Record, len(h.items)+1)
	for k, v := range h.items {
		next[k] = v
	}
	entries := make([]Record, 0, len(h.items[connID]))
	for _, entry := range h.items[connID] {
		if entry.ID != id {
			entries = append(entries, entry)
		}
	}
	next[connID] = entries
	if err := Save(h.path, next); err != nil {
		return nil, err
	}
	h.items = next
	return summaries(entries), nil
}

func (h *History) Clear(connID string) ([]Summary, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.ensure(); err != nil {
		return nil, err
	}
	next := make(map[string][]Record, len(h.items)+1)
	for k, v := range h.items {
		next[k] = v
	}
	next[connID] = nil
	if err := Save(h.path, next); err != nil {
		return nil, err
	}
	h.items = next
	return []Summary{}, nil
}

func summaries(entries []Record) []Summary {
	out := make([]Summary, 0, len(entries))
	for _, entry := range entries {
		out = append(out, entry.Summary())
	}
	return out
}
