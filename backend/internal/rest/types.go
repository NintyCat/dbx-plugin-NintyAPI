package rest

import "time"

// KV is a key/value row from the UI tables. A nil Enabled means the row is on.
type KV struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Enabled *bool  `json:"enabled,omitempty"`
}

func (kv KV) on() bool { return kv.Enabled == nil || *kv.Enabled }

type BodySpec struct {
	Type    string `json:"type"` // none|json|xml|raw|form|multipart|binary
	Content string `json:"content,omitempty"`
	Fields  []KV   `json:"fields,omitempty"` // form / multipart; multipart values prefixed with @ are file paths
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
