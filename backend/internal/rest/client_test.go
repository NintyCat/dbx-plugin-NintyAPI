package rest

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func sendTo(t *testing.T, handler http.HandlerFunc, spec RequestSpec) *Response {
	t.Helper()
	return sendToWith(t, handler, spec, BaseEnv{})
}

func sendToWith(t *testing.T, handler http.HandlerFunc, spec RequestSpec, env BaseEnv) *Response {
	t.Helper()
	server := httptest.NewServer(handler)
	defer server.Close()
	if spec.Method == "" {
		spec.Method = http.MethodGet
	}
	spec.URL = server.URL
	resp, err := Send(context.Background(), env, spec)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func gzipped(t *testing.T, text string) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer := gzip.NewWriter(&buf)
	if _, err := writer.Write([]byte(text)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// The label the server puts on a response can lie, and unpacking is what makes
// it lie: net/http unpacks gzip itself and then keeps the body's Content-Type,
// so a site that answers a Go client with `application/x-gzip` hands the pane
// readable HTML under a binary label. The bytes have to win.
func TestDecompressedBodyOutranksABinaryLabel(t *testing.T) {
	const page = "<!DOCTYPE html>\n<html><body><h1>你好</h1></body></html>"
	resp := sendTo(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-gzip")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(gzipped(t, page))
	}, RequestSpec{})

	if resp.BodyBinary {
		t.Fatalf("a decompressed page came back binary: %q", resp.Body)
	}
	if resp.Body != page {
		t.Fatalf("body = %q, want %q", resp.Body, page)
	}
	if resp.SizeBytes != len(page) {
		t.Fatalf("size = %d, want the decompressed length %d", resp.SizeBytes, len(page))
	}
}

// A hand-written Accept-Encoding stops net/http from unpacking, so those bytes
// are the wire bytes and nothing can render them. Same server, same payload as
// the test above: only the request differs.
func TestHandWrittenAcceptEncodingKeepsTheBodyPacked(t *testing.T) {
	const page = "<!DOCTYPE html><html></html>"
	packed := gzipped(t, page)
	handler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-gzip")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(packed)
	}

	if resp := sendTo(t, handler, RequestSpec{}); resp.BodyBinary {
		t.Fatalf("without the header net/http unpacks, so this should be text: %#v", resp)
	}
	resp := sendTo(t, handler, RequestSpec{Headers: []KV{{Key: "Accept-Encoding", Value: "gzip"}}})
	if !resp.BodyBinary {
		t.Fatal("a still-packed body is not readable text")
	}
	raw, err := base64.StdEncoding.DecodeString(resp.Body)
	if err != nil {
		t.Fatalf("binary body is not base64: %v", err)
	}
	if !bytes.Equal(raw, packed) {
		t.Fatal("binary body must carry the compressed bytes, unchanged")
	}
}

func TestDecodeBodyWeighsBytesOverLabel(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d}
	for _, tt := range []struct {
		name        string
		contentType string
		status      int
		body        []byte
		wantBinary  bool
		wantText    string
	}{
		{
			name:        "svg is text under an image type",
			contentType: "image/svg+xml",
			body:        []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`),
			wantText:    `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`,
		},
		{
			name:        "stream type carrying json",
			contentType: "application/octet-stream",
			body:        []byte(`{"ok":true}`),
			wantText:    `{"ok":true}`,
		},
		{
			name:        "legacy spreadsheet type carrying csv",
			contentType: "application/vnd.ms-excel",
			body:        []byte("名称,数量\n张三,2\n"),
			wantText:    "名称,数量\n张三,2\n",
		},
		{
			name:        "real image bytes",
			contentType: "image/png",
			body:        png,
			wantBinary:  true,
		},
		{
			name:        "gzip file download",
			contentType: "application/x-gzip",
			body:        gzipped(t, "存档内容"),
			wantBinary:  true,
		},
		{
			name:        "text label with a nul byte inside",
			contentType: "text/plain",
			body:        []byte("h\x00i"),
			wantBinary:  true,
		},
		{
			name:        "json",
			contentType: "application/json",
			body:        []byte(`{"ok":true}`),
			wantText:    `{"ok":true}`,
		},
		{
			name:        "empty body under a binary type",
			contentType: "application/octet-stream",
			status:      http.StatusNoContent,
			wantText:    "",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			resp := sendTo(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", tt.contentType)
				if tt.status != 0 {
					w.WriteHeader(tt.status)
				}
				_, _ = w.Write(tt.body)
			}, RequestSpec{})
			if resp.BodyBinary != tt.wantBinary {
				t.Fatalf("bodyBinary = %v, want %v (body %q)", resp.BodyBinary, tt.wantBinary, resp.Body)
			}
			if tt.wantBinary {
				raw, err := base64.StdEncoding.DecodeString(resp.Body)
				if err != nil {
					t.Fatalf("binary body is not base64: %v", err)
				}
				if !bytes.Equal(raw, tt.body) {
					t.Fatal("binary body does not round-trip")
				}
				return
			}
			if resp.Body != tt.wantText {
				t.Fatalf("body = %q, want %q", resp.Body, tt.wantText)
			}
		})
	}
}

// A HEAD carries the headers of a GET with none of its bytes, so the pane has
// nothing to render and must not claim a binary payload it never saw.
func TestHeadKeepsAnEmptyBodyEmpty(t *testing.T) {
	resp := sendTo(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-gzip")
		w.Header().Set("Content-Length", "2443")
	}, RequestSpec{Method: http.MethodHead})
	if resp.BodyBinary || resp.Body != "" {
		t.Fatalf("HEAD body = %q (binary %v), want empty text", resp.Body, resp.BodyBinary)
	}
	if !strings.Contains(resp.ContentType, "application/x-gzip") {
		t.Fatalf("headers were lost: %#v", resp.Headers)
	}
}

// Without a jar every request is anonymous, so a login could never be reused;
// with one, the Set-Cookie of the first response travels on the next request.
func TestSessionCookiesTravelBetweenRequests(t *testing.T) {
	var sent []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sent = append(sent, r.Header.Get("Cookie"))
		if r.URL.Path == "/login" {
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "s1", Path: "/"})
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	send := func(env BaseEnv, path string) {
		t.Helper()
		if _, err := Send(context.Background(), env, RequestSpec{Method: http.MethodGet, URL: server.URL + path}); err != nil {
			t.Fatal(err)
		}
	}

	send(BaseEnv{Cookies: jar}, "/login")
	send(BaseEnv{Cookies: jar}, "/users")
	if len(sent) != 2 || sent[0] != "" || sent[1] != "sid=s1" {
		t.Fatalf("the session did not travel: %#v", sent)
	}

	// The same exchange without a jar remembers nothing, which is what every
	// request looked like before there was a store.
	sent = nil
	send(BaseEnv{}, "/login")
	send(BaseEnv{}, "/users")
	if len(sent) != 2 || sent[1] != "" {
		t.Fatalf("a jar-less request carried a cookie: %#v", sent)
	}
}

// The response reports the cookies that went out, from the jar or from a header
// typed by hand, so the pane can show the session rather than leaving its
// origin a mystery.
func TestResponseReportsTheCookiesItSent(t *testing.T) {
	var seen string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("Cookie")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	jar, _ := cookiejar.New(nil)
	jar.SetCookies(mustURL(t, server.URL+"/"), []*http.Cookie{{Name: "sid", Value: "s1", Path: "/"}})
	resp, err := Send(context.Background(), BaseEnv{Cookies: jar}, RequestSpec{
		Method:  http.MethodGet,
		URL:     server.URL,
		Headers: []KV{{Key: "cookie", Value: "manual=1"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen != "manual=1; sid=s1" {
		t.Fatalf("server saw %q", seen)
	}
	if names := cookieNames(resp); names != "sid manual" {
		t.Fatalf("cookies reported: %s", names)
	}
	// Where each one came from is the point: one is the connection's session,
	// the other was typed into this request.
	if resp.Cookies[0].From != "jar" || resp.Cookies[1].From != "header" {
		t.Fatalf("cookie origins lost: %#v", resp.Cookies)
	}
	if resp.Cookies[0].Value != "s1" {
		t.Fatalf("cookie value lost: %#v", resp.Cookies[0])
	}
}

// A cookie set on one redirect hop is sent to the next hop of the same host,
// and never follows the redirect to another one.
func TestRedirectHopsKeepCookiesOnTheirOwnHost(t *testing.T) {
	var hopCookies []string
	var redirectTo string
	handler := func(w http.ResponseWriter, r *http.Request) {
		hopCookies = append(hopCookies, r.Header.Get("Cookie"))
		http.SetCookie(w, &http.Cookie{Name: "sid", Value: "s1", Path: "/"})
		if r.URL.Path != "/final" && r.URL.Path != "/landing" {
			http.Redirect(w, r, redirectTo, http.StatusFound)
		}
	}
	jar, _ := cookiejar.New(nil)
	env := BaseEnv{Cookies: jar}
	server := httptest.NewServer(http.HandlerFunc(handler))
	defer server.Close()

	redirectTo = server.URL + "/final"
	if _, err := Send(context.Background(), env, RequestSpec{Method: http.MethodGet, URL: server.URL}); err != nil {
		t.Fatal(err)
	}
	if len(hopCookies) != 2 || hopCookies[0] != "" || hopCookies[1] != "sid=s1" {
		t.Fatalf("the hop lost the cookie it was just given: %#v", hopCookies)
	}

	// Same port, another host name: cookies do not know about ports, but they
	// do know about hosts.
	hopCookies = nil
	redirectTo = strings.Replace(server.URL, "127.0.0.1", "localhost", 1) + "/landing"
	if _, err := Send(context.Background(), env, RequestSpec{Method: http.MethodGet, URL: server.URL + "/jump"}); err != nil {
		t.Fatal(err)
	}
	if len(hopCookies) != 2 {
		t.Fatalf("expected two hops, saw %#v", hopCookies)
	}
	if !strings.Contains(hopCookies[0], "sid=s1") {
		t.Fatalf("the first hop did not carry its cookie: %#v", hopCookies)
	}
	if hopCookies[1] != "" {
		t.Fatalf("the cookie followed the redirect to another host: %q", hopCookies[1])
	}
}

func cookieNames(resp *Response) string {
	names := make([]string, 0, len(resp.Cookies))
	for _, c := range resp.Cookies {
		names = append(names, c.Name)
	}
	return strings.Join(names, " ")
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
