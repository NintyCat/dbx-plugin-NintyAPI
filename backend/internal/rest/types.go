package rest

import (
	"io"
	"strings"
	"time"
)

// KV is a key/value row from the UI tables. A nil Enabled means the row is on.
type KV struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Enabled *bool  `json:"enabled,omitempty"`
}

func (kv KV) on() bool { return kv.Enabled == nil || *kv.Enabled }

// FileRef names the file a form part or a binary body sends.
//
// The workbench UI runs in a sandboxed iframe and cannot name a path on disk,
// so a file the user picked can only reach the sidecar as bytes: the UI streams
// them to the upload store, which mints ID. Path is the other route — a file on
// the machine running DBX, which is all a cURL import or a hand-typed "@path"
// can offer. ID wins when both are set, because picked bytes are known to be
// there while a saved path may have moved since it was written down.
type FileRef struct {
	ID          string `json:"id,omitempty"`
	Path        string `json:"path,omitempty"`
	Name        string `json:"name,omitempty"`
	ContentType string `json:"contentType,omitempty"`
}

// FileResolver turns a FileRef carrying an ID into readable bytes. The
// sidecar's upload store implements it; path-only callers pass nil.
type FileResolver interface {
	Open(ref FileRef) (io.ReadCloser, error)
}

// FormField is one row of a form or multipart body. A text row carries Value; a
// file row carries Files, and sends one part per file under the row's key —
// which is what a browser does for a multiple file input. Kind is "text" or
// "file" once the editor has an opinion, and empty on rows saved before file
// picking existed — those fall back to reading a leading "@" as a path, which is
// how cURL spells a file.
type FormField struct {
	Key     string    `json:"key"`
	Value   string    `json:"value,omitempty"`
	Enabled *bool     `json:"enabled,omitempty"`
	Kind    string    `json:"kind,omitempty"`
	Files   []FileRef `json:"files,omitempty"`
	// File is the single-file shape written before a row could carry several.
	// It is read for compatibility and never written back.
	File *FileRef `json:"file,omitempty"`
}

func (f FormField) on() bool { return f.Enabled == nil || *f.Enabled }

// wantsFile reports whether this row is a file row, whether or not it has been
// given a file yet. A row that wants a file but has none must not be sent as an
// empty text field, which would look to the server like a successful upload of
// nothing.
func (f FormField) wantsFile() bool {
	return f.Kind == "file" || f.File != nil || len(f.Files) > 0
}

// fileRefs reports the files this row sends, in order. Every shape a row can
// arrive in is folded here, so the sender only ever sees a list.
func (f FormField) fileRefs() []FileRef {
	if f.Kind == "text" {
		return nil
	}
	var out []FileRef
	for _, ref := range f.Files {
		if ref.ID != "" || ref.Path != "" {
			out = append(out, ref)
		}
	}
	if len(out) > 0 {
		return out
	}
	if f.File != nil && (f.File.ID != "" || f.File.Path != "") {
		return []FileRef{*f.File}
	}
	if f.Kind == "file" {
		return nil
	}
	if path, found := strings.CutPrefix(strings.TrimSpace(f.Value), "@"); found && path != "" {
		return []FileRef{{Path: path}}
	}
	return nil
}

type BodySpec struct {
	Type    string      `json:"type"` // none|json|xml|raw|form|multipart|binary
	Content string      `json:"content,omitempty"`
	Fields  []FormField `json:"fields,omitempty"` // form / multipart
	// File is a binary body's payload. Content still holds a path for requests
	// saved before the workbench could pick files.
	File *FileRef `json:"file,omitempty"`
}

type AuthSpec struct {
	Type     string `json:"type"` // none|bearer|basic
	Token    string `json:"token,omitempty"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

type Settings struct {
	FollowRedirects *bool `json:"followRedirects,omitempty"`
	VerifyTLS       *bool `json:"verifyTLS,omitempty"`
	TimeoutMs       int   `json:"timeoutMs,omitempty"`
}

func (s Settings) followRedirects() bool { return s.FollowRedirects == nil || *s.FollowRedirects }
func (s Settings) verifyTLS() bool       { return s.VerifyTLS == nil || *s.VerifyTLS }

// RequestSpec is the full editable request as sent by the workbench.
type RequestSpec struct {
	Method      string    `json:"method"`
	URL         string    `json:"url"`
	Headers     []KV      `json:"headers,omitempty"`
	QueryParams []KV      `json:"queryParams,omitempty"`
	Body        *BodySpec `json:"body,omitempty"`
	Auth        *AuthSpec `json:"auth,omitempty"`
	Settings    Settings  `json:"settings"`
}

type Timing struct {
	DNSMs       int64 `json:"dnsMs"`
	ConnectMs   int64 `json:"connectMs"`
	TLSMs       int64 `json:"tlsMs"`
	FirstByteMs int64 `json:"firstByteMs"`
	DownloadMs  int64 `json:"downloadMs"`
}

type RedirectStep struct {
	Status   int    `json:"status"`
	Location string `json:"location"`
}

// Cookie is one cookie a request carried. The stdlib jar hands back nothing but
// names and values — the attributes live on the Set-Cookie that set them — so
// this describes what went out on the wire, not a full cookie record.
type Cookie struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	From  string `json:"from"` // "jar" for the connection's store, "header" for one typed by hand
}

// Response is returned even for transport failures: Status stays 0 and Err
// carries the message so the UI can render failures inline.
type Response struct {
	Status      int            `json:"status"`
	StatusText  string         `json:"statusText"`
	Proto       string         `json:"proto"`
	Headers     []KV           `json:"headers"`
	ContentType string         `json:"contentType"`
	Body        string         `json:"body"`
	BodyBinary  bool           `json:"bodyBinary"`
	Truncated   bool           `json:"truncated"`
	SizeBytes   int            `json:"sizeBytes"`
	TimeMs      int64          `json:"timeMs"`
	Timing      Timing         `json:"timing"`
	Cookies     []Cookie       `json:"cookies,omitempty"`
	URL         string         `json:"url"`
	Redirects   []RedirectStep `json:"redirects,omitempty"`
	Err         string         `json:"error,omitempty"`
}

// defaultTimeout bounds a single request when neither settings nor the
// connection specify one.
const defaultTimeout = 30 * time.Second

// MaxTimeoutMs caps the request timeout configured from the UI (5 minutes).
const MaxTimeoutMs = 300_000

// maxBodyBytes caps how much of a response body is buffered and shipped to
// the UI; larger bodies are marked truncated.
const maxBodyBytes = 10 << 20

// maxRequestBytes caps a request body read from a picked file. It is larger
// than maxBodyBytes because a response is held twice over — once as bytes and
// once as the JSON that carries them to the UI — while a request body only has
// to fit in memory once.
const maxRequestBytes = 64 << 20
