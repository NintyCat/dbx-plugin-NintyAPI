package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/connection"
	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/rest"
	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/store"
	dbx "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

// rpcClient drives the plugin the way the host does: every RPC enters through
// Handle with a JSON body and comes back as a result or a PluginError.
type rpcClient struct{ p *plugin }

// newTestPlugin wires a plugin to a temp directory and pre-attaches the
// "test" connection the fixtures rely on.
func newTestPlugin(t *testing.T) *rpcClient {
	t.Helper()
	dir := t.TempDir()
	p := &plugin{
		envs:        connection.New(),
		collections: store.NewCollections(filepath.Join(dir, "collections.json")),
		history:     store.NewHistory(filepath.Join(dir, "history.json")),
	}
	p.settings.path = filepath.Join(dir, "preferences.json")
	p.envs.Attach("test", &connection.Env{ID: "test", BaseURL: "http://example.invalid", Timeout: 5 * time.Second})
	return &rpcClient{p: p}
}

// bareClient skips the fixture wiring for routes that touch no state.
func bareClient() *rpcClient { return &rpcClient{p: &plugin{}} }

func (c *rpcClient) call(method, body string) (any, *dbx.PluginError) {
	return c.p.Handle(dbx.RequestContext{}, method, json.RawMessage(body), nil)
}

func TestProtocolRejectsInvalidRequests(t *testing.T) {
	c := newTestPlugin(t)
	for _, tt := range []struct {
		method, body string
		code         int
	}{
		{"http/typo", `{}`, -32601},
		{"resource/list", `{}`, -32601},
		{"http/request", `[]`, -32602},
		{"connection/disconnect", `{"connectionId":3}`, -32602},
		{"http/request", `{}`, -32602},
		{"http/request", `{"connectionId":"test","url":""}`, -32602},
		{"http/request", `{"connectionId":"test","url":"ftp://x"}`, -32602},
		{"collection/save", `{"connectionId":"test","item":{"type":"request"}}`, -32602},
		{"curl/parse", `{}`, -32602},
		{"curl/parse", `{"connectionId":"test","command":"curl"}`, -32602},
	} {
		t.Run(tt.method+tt.body, func(t *testing.T) {
			_, err := c.call(tt.method, tt.body)
			if err == nil || err.Code != tt.code {
				t.Fatalf("got %#v, expected %d", err, tt.code)
			}
		})
	}
}

func TestPingRoute(t *testing.T) {
	c := newTestPlugin(t)
	out, err := c.call("rest/ping", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	if out.(map[string]any)["ok"] != true {
		t.Fatalf("bad ping: %#v", out)
	}
}

func TestCollectionCRUDAndCascade(t *testing.T) {
	c := newTestPlugin(t)
	out, err := c.call("collection/save", `{"connectionId":"test","item":{"type":"folder","name":"用户接口"}}`)
	if err != nil {
		t.Fatal(err)
	}
	folder := out.(map[string]any)["items"].([]store.Node)[0]
	out, err = c.call("collection/save", `{"connectionId":"test","item":{"type":"request","name":"登录","parentId":"`+folder.ID+`","method":"post","url":"/login"}}`)
	if err != nil {
		t.Fatal(err)
	}
	request := out.(map[string]any)["items"].([]store.Node)[1]
	if request.ParentID != folder.ID || request.Method != "POST" {
		t.Fatalf("bad saved node: %#v", request)
	}
	if _, err = c.call("collection/save", `{"connectionId":"test","item":{"id":"`+folder.ID+`","type":"folder","name":"moved","parentId":"`+request.ID+`"}}`); err == nil {
		t.Fatal("expected cycle rejection")
	}
	if _, err = c.call("collection/delete", `{"connectionId":"test","id":"`+folder.ID+`"}`); err != nil {
		t.Fatal(err)
	}
	out, _ = c.call("collection/list", `{"connectionId":"test"}`)
	if got := len(out.(map[string]any)["items"].([]store.Node)); got != 0 {
		t.Fatalf("expected cascade delete, got %d nodes", got)
	}
}

func TestConnectionAuthDefaults(t *testing.T) {
	c := newTestPlugin(t)
	var gotPath, gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	c.p.envs.Attach("test", &connection.Env{ID: "test", BaseURL: server.URL, AuthType: "bearer", Token: "abc123", Timeout: 5_000_000_000})
	out, err := c.call("http/request", `{"connectionId":"test","method":"get","url":"/users"}`)
	if err != nil {
		t.Fatal(err)
	}
	resp := out.(*rest.Response)
	if resp.Status != 200 || resp.Body != `{"ok":true}` || resp.BodyBinary {
		t.Fatalf("bad response: %#v", resp)
	}
	if gotPath != "/users" {
		t.Fatalf("path wrong: %q", gotPath)
	}
	if gotAuth != "Bearer abc123" {
		t.Fatalf("bearer auth missing: %q", gotAuth)
	}
	history, _ := c.p.history.List("test", 10)
	if len(history) != 1 || history[0].Status != 200 {
		t.Fatalf("history not recorded: %#v", history)
	}
}

func TestQueryParamsAndFormBody(t *testing.T) {
	c := newTestPlugin(t)
	var gotQuery, gotType, gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		gotType = r.Header.Get("Content-Type")
		buf := make([]byte, 256)
		n, _ := r.Body.Read(buf)
		gotBody = string(buf[:n])
		w.WriteHeader(201)
	}))
	defer server.Close()
	c.p.envs.Attach("test", &connection.Env{ID: "test", BaseURL: server.URL, Timeout: 5_000_000_000})
	body := `{"connectionId":"test","method":"post","url":"/search","queryParams":[{"key":"page","value":"1"},{"key":"skip","value":"9","enabled":false}],"body":{"type":"form","fields":[{"key":"user","value":"张三"}]}}`
	out, err := c.call("http/request", body)
	if err != nil {
		t.Fatal(err)
	}
	resp := out.(*rest.Response)
	if resp.Status != 201 {
		t.Fatalf("expected 201, got %d", resp.Status)
	}
	if gotQuery != "page=1" {
		t.Fatalf("query params wrong: %q", gotQuery)
	}
	if !strings.HasPrefix(gotType, "application/x-www-form-urlencoded") {
		t.Fatalf("content type wrong: %q", gotType)
	}
	if gotBody != "user=%E5%BC%A0%E4%B8%89" {
		t.Fatalf("form body wrong: %q", gotBody)
	}
}

func TestRedirectChainCaptured(t *testing.T) {
	c := newTestPlugin(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/final" {
			w.WriteHeader(200)
			return
		}
		http.Redirect(w, r, "/final", http.StatusFound)
	}))
	defer server.Close()
	c.p.envs.Attach("test", &connection.Env{ID: "test", BaseURL: server.URL, Timeout: 5_000_000_000})
	out, err := c.call("http/request", `{"connectionId":"test","method":"get","url":"/start"}`)
	if err != nil {
		t.Fatal(err)
	}
	resp := out.(*rest.Response)
	if resp.Status != 200 || resp.URL != server.URL+"/final" || len(resp.Redirects) != 1 || resp.Redirects[0].Status != 302 {
		t.Fatalf("bad redirect handling: %#v", resp)
	}
}

func TestNetworkFailureIsInline(t *testing.T) {
	c := newTestPlugin(t)
	out, err := c.call("http/request", `{"connectionId":"test","method":"get","url":"http://127.0.0.1:1/x"}`)
	if err != nil {
		t.Fatal(err)
	}
	resp := out.(*rest.Response)
	if resp.Status != 0 || resp.Err == "" {
		t.Fatalf("expected inline network error, got %#v", resp)
	}
}

func TestCurlParse(t *testing.T) {
	spec, err := bareClient().call("curl/parse", `{"connectionId":"test","command":"curl -X POST 'https://api.example.com/v1/users?full=1' -H 'Content-Type: application/json' -H 'Authorization: Bearer tk' -d '{\"name\":\"张三\"}' -k"}`)
	if err != nil {
		t.Fatal(err)
	}
	item := spec.(map[string]any)["item"].(rest.RequestSpec)
	if item.Method != "POST" || item.URL != "https://api.example.com/v1/users?full=1" {
		t.Fatalf("bad parse: %#v", item)
	}
	if item.Body == nil || item.Body.Type != "json" || !strings.Contains(item.Body.Content, "张三") {
		t.Fatalf("bad body: %#v", item.Body)
	}
	if len(item.Headers) != 2 || item.Headers[1].Value != "Bearer tk" {
		t.Fatalf("bad headers: %#v", item.Headers)
	}
	if item.Settings.VerifyTLS == nil || *item.Settings.VerifyTLS {
		t.Fatalf("-k must disable TLS verification: %#v", item.Settings)
	}
}

func TestOpenAPIImport(t *testing.T) {
	c := newTestPlugin(t)
	const doc = `{
		"openapi": "3.0.0",
		"info": {"title": "宠物商店"},
		"paths": {
			"/pets": {
				"get": {"tags": ["宠物"], "summary": "列出宠物", "parameters": [{"name": "limit", "in": "query", "schema": {"type": "integer"}}]},
				"post": {"tags": ["宠物"], "summary": "新建宠物", "requestBody": {"content": {"application/json": {"schema": {"type": "object", "properties": {"name": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string"}}}}}}}}
			},
			"/health": {"get": {"summary": "健康检查"}}
		}
	}`
	out, err := c.call("collection/import-openapi", `{"connectionId":"test","document":`+strconv.Quote(doc)+`}`)
	if err != nil {
		t.Fatal(err)
	}
	result := out.(map[string]any)
	if result["created"].(int) != 3 {
		t.Fatalf("expected 3 requests, got %#v", result["created"])
	}
	nodes := result["items"].([]store.Node)
	var root, pets, health *store.Node
	for i := range nodes {
		switch nodes[i].Name {
		case "宠物商店":
			root = &nodes[i]
		case "列出宠物":
			pets = &nodes[i]
		case "健康检查":
			health = &nodes[i]
		}
	}
	if root == nil || pets == nil || health == nil {
		t.Fatalf("missing nodes: %#v", nodes)
	}
	if pets.ParentID == root.ID || health.ParentID != root.ID {
		t.Fatalf("tag folder grouping wrong: pets@%s health@%s root@%s", pets.ParentID, health.ParentID, root.ID)
	}
	if pets.Method != "GET" || len(pets.QueryParams) != 1 || pets.QueryParams[0].Key != "limit" {
		t.Fatalf("query param not imported: %#v", pets)
	}
	var post *store.Node
	for i := range nodes {
		if nodes[i].Name == "新建宠物" {
			post = &nodes[i]
		}
	}
	if post == nil || post.Body == nil || post.Body.Type != "json" || !strings.Contains(post.Body.Content, `"name":"string"`) {
		t.Fatalf("json body skeleton not generated: %#v", post)
	}
}

func TestOpenAPIImportRejectsNonOpenAPI(t *testing.T) {
	c := newTestPlugin(t)
	if _, err := c.call("collection/import-openapi", `{"connectionId":"test","document":"{\"hello\":\"world\"}"}`); err == nil {
		t.Fatal("expected rejection of non-OpenAPI document")
	}
	if _, err := c.call("collection/import-openapi", `{"connectionId":"test","document":"not json"}`); err == nil {
		t.Fatal("expected rejection of invalid JSON")
	}
}

// The plugin UI reaches the clipboard through the sidecar, so the RPC has to
// survive in both directions with nothing but the platform's own tools.
func TestClipboardRoundTrip(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("clipboard stubs are POSIX shell scripts")
	}
	dir := t.TempDir()
	reader, writer := "pbpaste", "pbcopy"
	if runtime.GOOS == "linux" {
		reader, writer = "wl-paste", "wl-copy"
	}
	writeExecutable(t, filepath.Join(dir, reader), `printf '来自剪贴板'`)
	captured := filepath.Join(dir, "captured")
	writeExecutable(t, filepath.Join(dir, writer), `cat > "$FAKE_CAPTURE"`)
	t.Setenv("FAKE_CAPTURE", captured)
	t.Setenv("PATH", strings.Join([]string{dir, "/bin", "/usr/bin"}, string(os.PathListSeparator)))

	c := newTestPlugin(t)
	out, err := c.call("clipboard/read-text", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	if out.(map[string]any)["text"] != "来自剪贴板" {
		t.Fatalf("bad clipboard read: %#v", out)
	}
	if _, err := c.call("clipboard/write-text", `{}`); err == nil || err.Code != -32602 {
		t.Fatalf("expected a params error, got %#v", err)
	}
	if _, err := c.call("clipboard/write-text", `{"text":"写回剪贴板"}`); err != nil {
		t.Fatal(err)
	}
	got, e := os.ReadFile(captured)
	if e != nil {
		t.Fatal(e)
	}
	if string(got) != "写回剪贴板" {
		t.Fatalf("got %q", got)
	}
}

func writeExecutable(t *testing.T, path, script string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

// History has to carry the whole exchange: the parameters that went out, the
// response that came back, and when it happened.
func TestHistoryRecordsFullExchange(t *testing.T) {
	c := newTestPlugin(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	c.p.envs.Attach("test", &connection.Env{ID: "test", BaseURL: server.URL, Timeout: 5_000_000_000})
	body := `{"connectionId":"test","method":"post","url":"/users","queryParams":[{"key":"page","value":"2"}],` +
		`"headers":[{"key":"X-Trace","value":"abc"}],"auth":{"type":"bearer","token":"tk"},` +
		`"body":{"type":"json","content":"{\"name\":\"张三\"}"}}`
	if _, err := c.call("http/request", body); err != nil {
		t.Fatal(err)
	}
	list, err := c.call("history/list", `{"connectionId":"test"}`)
	if err != nil {
		t.Fatal(err)
	}
	rows := list.(map[string]any)["items"].([]store.Summary)
	if len(rows) != 1 {
		t.Fatalf("expected one entry, got %d", len(rows))
	}
	row := rows[0]
	if row.Method != "POST" || row.Status != 200 || row.CreatedAt.IsZero() {
		t.Fatalf("bad row: %#v", row)
	}
	if !strings.HasSuffix(row.URL, "/users?page=2") {
		t.Fatalf("row url: %q", row.URL)
	}
	detail, err := c.call("history/get", `{"connectionId":"test","id":`+strconv.Quote(row.ID)+`}`)
	if err != nil {
		t.Fatal(err)
	}
	record := detail.(map[string]any)["item"].(store.Record)
	if record.Request.Headers[0].Key != "X-Trace" || record.Request.QueryParams[0].Value != "2" ||
		record.Request.Auth.Token != "tk" || record.Request.Body.Content != `{"name":"张三"}` {
		t.Fatalf("request parameters lost: %#v", record.Request)
	}
	if record.Response == nil || record.Response.Status != 200 || record.Response.Body != `{"ok":true}` {
		t.Fatalf("response lost: %#v", record.Response)
	}
	if _, err := c.call("history/get", `{"connectionId":"test","id":"missing"}`); err == nil {
		t.Fatal("expected an error for an unknown history id")
	}
}

func TestPreferencesRoundTrip(t *testing.T) {
	c := newTestPlugin(t)
	if _, err := c.call("ui/preferences-set", `{"connectionId":"test","key":"activeEnvironment","value":"env1"}`); err != nil {
		t.Fatal(err)
	}
	out, err := c.call("ui/preferences-get", `{"connectionId":"test"}`)
	if err != nil {
		t.Fatal(err)
	}
	values := out.(map[string]any)["values"].(map[string]string)
	if values["activeEnvironment"] != "env1" {
		t.Fatalf("preference lost: %#v", values)
	}
}

// A session has to survive from one request to the next, and clearing has to
// end it — through the same RPCs the workbench calls.
func TestCookiesSurviveRequestsUntilCleared(t *testing.T) {
	c := newTestPlugin(t)
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("Cookie"))
		if r.URL.Path == "/login" {
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "s1", Path: "/"})
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	c.p.envs.Attach("test", &connection.Env{ID: "test", BaseURL: server.URL, Timeout: 5_000_000_000})

	if _, err := c.call("http/request", `{"connectionId":"test","method":"post","url":"/login"}`); err != nil {
		t.Fatal(err)
	}
	out, err := c.call("http/request", `{"connectionId":"test","method":"get","url":"/me"}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(seen) != 2 || seen[1] != "sid=s1" {
		t.Fatalf("session did not travel: %#v", seen)
	}
	if resp := out.(*rest.Response); len(resp.Cookies) != 1 || resp.Cookies[0].Name != "sid" ||
		resp.Cookies[0].From != "jar" {
		t.Fatalf("response did not report the session cookie: %#v", resp.Cookies)
	}

	if _, err := c.call("cookie/clear", `{"connectionId":"test"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := c.call("http/request", `{"connectionId":"test","method":"get","url":"/me"}`); err != nil {
		t.Fatal(err)
	}
	if seen[2] != "" {
		t.Fatalf("cookie survived the clear: %q", seen[2])
	}
}
