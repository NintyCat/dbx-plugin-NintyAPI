package connection

import (
	"context"
	"crypto/tls"
	"errors"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// Manager tracks the environments that are live in this sidecar run, plus the
// cookie jar that belongs to each connection. Jars live beside the registry —
// not inside the environment — so disconnect + connect behaves like a page
// reload rather than a logout.
type Manager struct {
	mu       sync.RWMutex
	active   map[string]*Env
	sessions map[string]*Jar
}

func New() *Manager {
	return &Manager{active: map[string]*Env{}, sessions: map[string]*Jar{}}
}

// jarLocked returns the connection's jar, creating it on first use.
// Callers must hold the write lock.
func (m *Manager) jarLocked(id string) *Jar {
	jar, ok := m.sessions[id]
	if !ok {
		jar = NewJar()
		m.sessions[id] = jar
	}
	return jar
}

// Attach publishes a probed environment and hands it its cookie jar.
func (m *Manager) Attach(id string, env *Env) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.active[id] = env
	env.Cookies = m.jarLocked(id)
}

// Fetch returns the live environment, or an error when the workbench never
// connected (or already dropped) this connection in the current run.
func (m *Manager) Fetch(id string) (*Env, error) {
	if id == "" {
		return nil, errors.New("缺少 connectionId")
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	env, ok := m.active[id]
	if !ok {
		return nil, errors.New("连接尚未建立")
	}
	return env, nil
}

// Forget drops one live connection. The jar survives until ClearCookies says
// otherwise.
func (m *Manager) Forget(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.active, id)
}

// ClearCookies empties the jar a connection has been filling.
func (m *Manager) ClearCookies(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.jarLocked(id).Clear()
}

// Report is what connection/test and connection/connect hand back to the UI.
type Report struct {
	Success      bool   `json:"success"`
	ConnectionID string `json:"connectionId,omitempty"`
	BaseURL      string `json:"baseUrl"`
	Message      string `json:"message"`
	ElapsedMs    int64  `json:"elapsedMs"`
}

// Probe dials the base URL once. Any HTTP status proves the server is there —
// an API client cares about reachability, not whether a specific endpoint
// exists, so a 404 or 500 still counts as connected.
func Probe(ctx context.Context, env *Env) (*Report, error) {
	report := &Report{
		Success:      true,
		ConnectionID: env.ID,
		BaseURL:      env.BaseURL,
		Message:      "环境已就绪，未设置 Base URL 时将使用完整请求地址",
	}
	if env.BaseURL == "" {
		return report, nil
	}
	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			Proxy:           dialProxy(env.Proxy),
			TLSClientConfig: &tls.Config{InsecureSkipVerify: env.InsecureTLS},
		},
	}
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, env.BaseURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	report.ElapsedMs = time.Since(start).Milliseconds()
	if err != nil {
		return nil, err
	}
	resp.Body.Close()
	report.Message = "API 服务器可达"
	return report, nil
}

// dialProxy pins every request of a probe to the configured proxy, falling
// back to the environment's proxy rules when none is set (or unparsable).
func dialProxy(addr string) func(*http.Request) (*url.URL, error) {
	if addr == "" {
		return http.ProxyFromEnvironment
	}
	parsed, err := url.Parse(addr)
	if err != nil {
		return http.ProxyFromEnvironment
	}
	return func(*http.Request) (*url.URL, error) { return parsed, nil }
}

// Prepare resolves and probes a connection without registering it: a failed
// test must not leave a half-open connection behind.
func Prepare(params map[string]any) (*Env, *Report, error) {
	env, err := Resolve(params)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), env.Timeout)
	defer cancel()
	report, err := Probe(ctx, env)
	if err != nil {
		return nil, nil, err
	}
	report.ConnectionID = env.ID
	return env, report, nil
}
