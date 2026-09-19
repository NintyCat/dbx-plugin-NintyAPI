package rest

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
)

// BaseEnv carries the connection-level defaults applied to every request.
type BaseEnv struct {
	BaseURL     string
	AuthType    string
	Token       string
	Username    string
	Password    string
	InsecureTLS bool
	Proxy       string
	// Cookies holds the connection's session cookies. Requests are otherwise
	// independent, so this is the only thing that survives from one to the next.
	Cookies http.CookieJar
}

func (e BaseEnv) proxyFunc() func(*http.Request) (*url.URL, error) {
	if e.Proxy == "" {
		return http.ProxyFromEnvironment
	}
	u, err := url.Parse(e.Proxy)
	if err != nil {
		return http.ProxyFromEnvironment
	}
	return func(*http.Request) (*url.URL, error) { return u, nil }
}

var methods = map[string]bool{
	http.MethodGet: true, http.MethodPost: true, http.MethodPut: true, http.MethodDelete: true,
	http.MethodPatch: true, http.MethodHead: true, http.MethodOptions: true, http.MethodTrace: true,
}

// maxRedirects bounds the manual redirect loop.
const maxRedirects = 10

// Send applies environment defaults, executes the request and decodes the
// response. Transport failures come back as a Response with Status 0 so the UI
// can render them inline; only invalid input is a Go error.
func Send(ctx context.Context, env BaseEnv, spec RequestSpec) (*Response, error) {
	spec = applyEnv(spec, env)
	method := strings.ToUpper(strings.TrimSpace(spec.Method))
	if method == "" {
		method = http.MethodGet
	}
	if !methods[method] {
		return nil, fmt.Errorf("不支持的 HTTP 方法 %q", spec.Method)
	}
	target, err := resolveURL(env.BaseURL, spec.URL, spec.QueryParams)
	if err != nil {
		return nil, err
	}
	body, contentType, contentLength, err := openBody(spec.Body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, errors.New("请求地址无效")
	}
	applyAuth(req, spec.Auth)
	for _, h := range spec.Headers {
		if h.on() && h.Key != "" {
			req.Header.Set(h.Key, h.Value)
		}
	}
	if contentType != "" && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", contentType)
	}
	if contentLength >= 0 {
		req.ContentLength = contentLength
	}
	timeout := defaultTimeout
	if spec.Settings.TimeoutMs > 0 {
		timeout = time.Duration(min(spec.Settings.TimeoutMs, MaxTimeoutMs)) * time.Millisecond
	}
	transport := &http.Transport{
		Proxy:             env.proxyFunc(),
		TLSClientConfig:   &tls.Config{InsecureSkipVerify: !spec.Settings.verifyTLS() || env.InsecureTLS},
		ForceAttemptHTTP2: true,
	}
	client := &http.Client{Transport: transport, Timeout: timeout}
	if env.Cookies != nil {
		client.Jar = env.Cookies
	}
	// The client writes the jar's cookies into the request it is handed, so a
	// copy of the headers as built here is what every later hop starts from.
	originHeader := req.Header.Clone()
	// Redirects are followed manually so the chain can be reported; the client
	// itself never follows (ErrUseLastResponse hands each hop back to us).
	if spec.Settings.followRedirects() {
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	var timing Timing
	var dnsStart, connectStart, tlsStart, firstByte time.Time
	trace := &httptrace.ClientTrace{
		DNSStart: func(httptrace.DNSStartInfo) { dnsStart = time.Now() },
		DNSDone: func(httptrace.DNSDoneInfo) {
			if !dnsStart.IsZero() {
				timing.DNSMs = time.Since(dnsStart).Milliseconds()
			}
		},
		ConnectStart: func(string, string) { connectStart = time.Now() },
		ConnectDone: func(string, string, error) {
			if !connectStart.IsZero() {
				timing.ConnectMs = time.Since(connectStart).Milliseconds()
			}
		},
		TLSHandshakeStart: func() { tlsStart = time.Now() },
		TLSHandshakeDone: func(tls.ConnectionState, error) {
			if !tlsStart.IsZero() {
				timing.TLSMs = time.Since(tlsStart).Milliseconds()
			}
		},
		GotFirstResponseByte: func() { firstByte = time.Now() },
	}
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))

	start := time.Now()
	current := req
	var redirects []RedirectStep
	for hop := 0; ; hop++ {
		// Read the cookies before sending: a Set-Cookie in the answer would
		// otherwise show up among the ones the request carried.
		sent := requestCookies(env.Cookies, current.URL, spec.Headers)
		resp, err := client.Do(current)
		if err != nil {
			out := &Response{URL: current.URL.String(), Headers: []KV{}, Err: errorText(err), TimeMs: time.Since(start).Milliseconds()}
			return out, nil
		}
		if isRedirect(resp) && spec.Settings.followRedirects() {
			location, status := resp.Header.Get("Location"), resp.StatusCode
			resp.Body.Close()
			redirects = append(redirects, RedirectStep{Status: status, Location: location})
			if hop+1 >= maxRedirects {
				return &Response{URL: current.URL.String(), Headers: []KV{}, Status: status, StatusText: "too many redirects", TimeMs: time.Since(start).Milliseconds()}, nil
			}
			current, err = followRedirect(current, originHeader, status, location)
			if err != nil {
				return &Response{URL: current.URL.String(), Headers: []KV{}, Err: errorText(err), TimeMs: time.Since(start).Milliseconds()}, nil
			}
			continue
		}
		out, err := finish(resp, start, &timing, firstByte, redirects)
		if out != nil {
			out.Cookies = sent
		}
		return out, err
	}
}

// requestCookies is what travels with this hop: the jar's cookies for the
// target plus whatever the request spelled out by hand, so the pane can show
// the session instead of leaving its origin a mystery.
func requestCookies(jar http.CookieJar, target *url.URL, headers []KV) []Cookie {
	out := []Cookie{}
	taken := map[string]bool{}
	if jar != nil {
		for _, c := range jar.Cookies(target) {
			out = append(out, Cookie{Name: c.Name, Value: c.Value, From: "jar"})
			taken[c.Name] = true
		}
	}
	for _, h := range headers {
		if !h.on() || !strings.EqualFold(h.Key, "Cookie") {
			continue
		}
		for _, pair := range strings.Split(h.Value, ";") {
			name, value, found := strings.Cut(strings.TrimSpace(pair), "=")
			if !found || name == "" || taken[name] {
				continue
			}
			out = append(out, Cookie{Name: name, Value: value, From: "header"})
			taken[name] = true
		}
	}
	return out
}

func isRedirect(resp *http.Response) bool {
	switch resp.StatusCode {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther, http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return resp.Header.Get("Location") != ""
	}
	return false
}

// followRedirect rebuilds the request for the next hop, downgrading the method
// to GET for 301/302/303 the way browsers and curl do. Headers come from the
// request as it was originally built, so the cookies the jar added for the
// previous hop — possibly another host — are not carried along.
func followRedirect(prev *http.Request, origin http.Header, status int, location string) (*http.Request, error) {
	next, err := prev.URL.Parse(location)
	if err != nil {
		return nil, err
	}
	method := prev.Method
	if status == http.StatusSeeOther || status == http.StatusMovedPermanently || status == http.StatusFound {
		if method != http.MethodHead && method != http.MethodGet && method != http.MethodOptions {
			method = http.MethodGet
		}
	}
	var body io.Reader
	if method == prev.Method && prev.Body != nil {
		if prev.GetBody == nil {
			return nil, errors.New("重定向过程中无法重发请求体")
		}
		if body, err = prev.GetBody(); err != nil {
			return nil, err
		}
	}
	req, err := http.NewRequestWithContext(prev.Context(), method, next.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header = origin.Clone()
	return req, nil
}

func finish(resp *http.Response, start time.Time, timing *Timing, firstByte time.Time, redirects []RedirectStep) (*Response, error) {
	defer resp.Body.Close()
	elapsed := time.Since(start)
	out := &Response{
		Status:      resp.StatusCode,
		StatusText:  strings.TrimPrefix(resp.Status, strconv.Itoa(resp.StatusCode)+" "),
		Proto:       resp.Proto,
		Headers:     []KV{},
		ContentType: resp.Header.Get("Content-Type"),
		URL:         resp.Request.URL.String(),
		TimeMs:      elapsed.Milliseconds(),
		Redirects:   redirects,
	}
	for name, values := range resp.Header {
		for _, value := range values {
			out.Headers = append(out.Headers, KV{Key: name, Value: value})
		}
	}
	raw, truncated := readBody(resp)
	out.Truncated = truncated
	out.SizeBytes = len(raw)
	out.Body, out.BodyBinary = decodeBody(raw, out.ContentType, resp.Header.Get("Content-Encoding"))
	if !firstByte.IsZero() {
		timing.FirstByteMs = firstByte.Sub(start).Milliseconds()
		timing.DownloadMs = elapsed.Milliseconds() - timing.FirstByteMs
	}
	out.Timing = *timing
	return out, nil
}

// applyEnv fills auth defaults from the connection.
func applyEnv(spec RequestSpec, env BaseEnv) RequestSpec {
	if spec.Auth == nil {
		spec.Auth = &AuthSpec{}
	}
	if spec.Auth.Type == "" || spec.Auth.Type == "none" {
		switch env.AuthType {
		case "bearer":
			spec.Auth = &AuthSpec{Type: "bearer", Token: env.Token}
		case "basic":
			spec.Auth = &AuthSpec{Type: "basic", Username: env.Username, Password: env.Password}
		}
	}
	return spec
}

// resolveURL joins a relative request URL with the environment base URL and
// appends enabled query parameters.
func resolveURL(base, raw string, params []KV) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("请填写请求地址")
	}
	target := raw
	if !strings.Contains(raw, "://") {
		if base == "" {
			return "", errors.New("未设置 Base URL 时，请求地址必须是完整地址")
		}
		if strings.HasPrefix(raw, "/") {
			target = base + raw
		} else {
			target = base + "/" + raw
		}
	}
	u, err := url.Parse(target)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", errors.New("请求地址必须是 http(s) 地址")
	}
	query := u.Query()
	for _, p := range params {
		if p.on() && p.Key != "" {
			query.Set(p.Key, p.Value)
		}
	}
	u.RawQuery = query.Encode()
	return u.String(), nil
}

func applyAuth(req *http.Request, auth *AuthSpec) {
	if auth == nil || auth.Type == "" || auth.Type == "none" {
		return
	}
	switch auth.Type {
	case "bearer":
		if auth.Token != "" {
			req.Header.Set("Authorization", "Bearer "+auth.Token)
		}
	case "basic":
		req.SetBasicAuth(auth.Username, auth.Password)
	}
}

var defaultContentTypes = map[string]string{
	"json": "application/json; charset=utf-8", "xml": "application/xml; charset=utf-8",
	"raw": "text/plain; charset=utf-8", "form": "application/x-www-form-urlencoded",
	"binary": "application/octet-stream",
}

// openBody materializes the request body. contentLength is -1 when unknown.
func openBody(body *BodySpec) (io.Reader, string, int64, error) {
	if body == nil || body.Type == "" || body.Type == "none" {
		return nil, "", -1, nil
	}
	contentType := defaultContentTypes[body.Type]
	switch body.Type {
	case "json", "xml", "raw":
		if body.Content == "" {
			return nil, contentType, 0, nil
		}
		return strings.NewReader(body.Content), contentType, int64(len(body.Content)), nil
	case "form":
		form := url.Values{}
		for _, f := range body.Fields {
			if f.on() && f.Key != "" {
				form.Set(f.Key, f.Value)
			}
		}
		encoded := form.Encode()
		return strings.NewReader(encoded), contentType, int64(len(encoded)), nil
	case "multipart":
		var buf bytes.Buffer
		writer := multipart.NewWriter(&buf)
		for _, f := range body.Fields {
			if !f.on() || f.Key == "" {
				continue
			}
			if strings.HasPrefix(f.Value, "@") {
				name := strings.TrimPrefix(f.Value, "@")
				file, err := os.Open(name)
				if err != nil {
					return nil, "", -1, fmt.Errorf("无法打开表单文件 %q：%w", name, err)
				}
				part, err := writer.CreateFormFile(f.Key, path.Base(file.Name()))
				if err == nil {
					_, err = io.Copy(part, file)
				}
				file.Close()
				if err != nil {
					return nil, "", -1, err
				}
			} else if err := writer.WriteField(f.Key, f.Value); err != nil {
				return nil, "", -1, err
			}
		}
		if err := writer.Close(); err != nil {
			return nil, "", -1, err
		}
		return bytes.NewReader(buf.Bytes()), writer.FormDataContentType(), int64(buf.Len()), nil
	case "binary":
		name := body.Content
		data, err := os.ReadFile(name)
		if err != nil {
			return nil, "", -1, fmt.Errorf("无法读取二进制请求体 %q：%w", name, err)
		}
		if len(data) > maxBodyBytes {
			return nil, "", -1, errors.New("二进制请求体超过 10 MiB")
		}
		return bytes.NewReader(data), contentType, int64(len(data)), nil
	}
	return nil, "", -1, fmt.Errorf("不支持的请求体类型 %q", body.Type)
}

func errorText(err error) string {
	var timeout interface{ Timeout() bool }
	if errors.As(err, &timeout) && timeout.Timeout() {
		return "request timeout"
	}
	msg := err.Error()
	for _, verb := range []string{"Get ", "Post ", "Put ", "Delete ", "Patch ", "Head "} {
		msg = strings.TrimPrefix(msg, verb)
	}
	return msg
}

func readBody(resp *http.Response) ([]byte, bool) {
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes+1))
	if err != nil && len(raw) == 0 {
		return nil, false
	}
	return raw, int64(len(raw)) > maxBodyBytes
}

// decodeBody turns the received bytes into what the response pane renders.
// Content-Type is a hint, never a verdict: net/http unpacks gzip on its own and
// then leaves the server's label in place, so a readable page can arrive
// labelled application/x-gzip (servers vary the label by User-Agent). The bytes
// decide, and only a body that is still compressed — the request carried a
// hand-written Accept-Encoding, so the transport left it alone — has no
// readable rendering at all.
func decodeBody(raw []byte, contentType, contentEncoding string) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	if coding := strings.ToLower(strings.TrimSpace(contentEncoding)); coding != "" && coding != "identity" {
		return base64.StdEncoding.EncodeToString(raw), true
	}
	if looksBinary(raw) || (isBinaryContentType(contentType) && !sniffsAsText(raw)) {
		return base64.StdEncoding.EncodeToString(raw), true
	}
	return string(raw), false
}

// sniffsAsText reports whether the bytes read as text on their own, whatever
// the header claims. It is what keeps a binary content type from base64-ing a
// body that is plainly readable, using the same table browsers sniff with.
func sniffsAsText(raw []byte) bool {
	return strings.HasPrefix(http.DetectContentType(raw), "text/")
}

func isBinaryContentType(contentType string) bool {
	media := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if media == "" {
		return false
	}
	for _, prefix := range []string{"image/", "audio/", "video/", "font/"} {
		if strings.HasPrefix(media, prefix) {
			return true
		}
	}
	switch media {
	case "application/octet-stream", "application/pdf", "application/zip", "application/gzip", "application/x-gzip",
		"application/x-tar", "application/x-7z-compressed", "application/x-rar-compressed", "application/wasm",
		"application/vnd.ms-excel", "application/msword",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		return true
	}
	return false
}

func looksBinary(raw []byte) bool {
	n := len(raw)
	if n > 512 {
		n = 512
	}
	for i := 0; i < n; i++ {
		if raw[i] == 0 {
			return true
		}
	}
	return false
}
