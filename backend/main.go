package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/clipboard"
	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/connection"
	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/rest"
	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/store"
	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/upload"
	dbx "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

const (
	pluginID        = "io.dbx.nintyapi"
	fallbackVersion = "0.1.12"
)

// resolveMetadata builds the identity this sidecar announces at startup. The
// manifest wins over the constant: inside an installed .dbxp it sits a few
// directories above the executable, and the host rejects the handshake when
// the two disagree. Walking upwards keeps a manifest version bump from
// silently breaking the handshake.
func resolveMetadata() dbx.Metadata {
	exe, err := os.Executable()
	if err != nil {
		return dbx.Metadata{ID: pluginID, Version: fallbackVersion, Capabilities: []string{"connections"}}
	}
	return resolveMetadataFromDir(filepath.Dir(exe))
}

func resolveMetadataFromDir(dir string) dbx.Metadata {
	metadata := dbx.Metadata{ID: pluginID, Version: fallbackVersion, Capabilities: []string{"connections"}}
	for i := 0; i < 6; i++ {
		data, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
		if err == nil {
			var manifest struct {
				ID      string `json:"id"`
				Version string `json:"version"`
			}
			// A foreign manifest must not hand us a wrong identity.
			if json.Unmarshal(data, &manifest) == nil && manifest.ID == pluginID && manifest.Version != "" {
				metadata.Version = manifest.Version
			}
			return metadata
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return metadata
		}
		dir = parent
	}
	return metadata
}

type plugin struct {
	envs        *connection.Manager
	collections *store.Collections
	history     *store.History
	uploads     *upload.Store
	settings    settings
}

// rpcHandler is one route. Routes with conn set get a validated connection id
// before they run; the rest receive an empty one.
type rpcHandler struct {
	conn bool
	run  func(p *plugin, connID string, params map[string]any, raw json.RawMessage) (any, *dbx.PluginError)
}

// rpcRoutes is the entire surface the workbench can call. Method names are
// the wire contract: changing one means changing the UI and the tests
// together.
var rpcRoutes = map[string]rpcHandler{
	"rest/ping": {run: func(*plugin, string, map[string]any, json.RawMessage) (any, *dbx.PluginError) {
		return map[string]any{"ok": true, "plugin": pluginID, "language": "go"}, nil
	}},
	"curl/parse": {run: func(_ *plugin, _ string, params map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		return runCurlParse(params)
	}},
	"clipboard/read-text": {run: func(*plugin, string, map[string]any, json.RawMessage) (any, *dbx.PluginError) {
		return readClipboard()
	}},
	"clipboard/write-text": {run: func(_ *plugin, _ string, params map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		return writeClipboard(params)
	}},
	// Uploads arrive in chunks because the host bridge caps one JSON parameter
	// at 2 MiB, well under any file worth sending. The workbench picks a file,
	// streams it here, and then names the upload in the request that consumes
	// it — see internal/upload for why the bytes cannot simply be a path.
	"upload/begin": {run: func(p *plugin, _ string, params map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		item, err := p.uploads.Begin(asString(params["name"]), asString(params["contentType"]), asInt64(params["size"]))
		if err != nil {
			return nil, toPluginError(err)
		}
		return map[string]any{"uploadId": item.ID, "chunkBytes": upload.MaxChunkBytes}, nil
	}},
	"upload/chunk": {run: func(p *plugin, _ string, params map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		data, err := base64.StdEncoding.DecodeString(asString(params["data"]))
		if err != nil {
			return nil, dbx.NewError(-32602, "上传分片不是合法的 base64")
		}
		received, err := p.uploads.Append(asString(params["uploadId"]), asInt64(params["offset"]), data)
		if err != nil {
			return nil, toPluginError(err)
		}
		return map[string]any{"received": received}, nil
	}},
	"upload/abort": {run: func(p *plugin, _ string, params map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		p.uploads.Drop(asString(params["uploadId"]))
		return map[string]any{"ok": true}, nil
	}},
	"ui/preferences-get": {run: func(p *plugin, _ string, params map[string]any, raw json.RawMessage) (any, *dbx.PluginError) {
		return p.servePreferences("ui/preferences-get", params, raw)
	}},
	"ui/preferences-set": {run: func(p *plugin, _ string, params map[string]any, raw json.RawMessage) (any, *dbx.PluginError) {
		return p.servePreferences("ui/preferences-set", params, raw)
	}},
	"connection/test": {run: func(_ *plugin, _ string, params map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		_, report, err := connection.Prepare(params)
		if err != nil {
			return map[string]any{"success": false, "message": err.Error()}, nil
		}
		return report, nil
	}},
	"connection/connect": {conn: true, run: func(p *plugin, connID string, params map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		env, report, err := connection.Prepare(params)
		if err != nil {
			return nil, toPluginError(err)
		}
		p.envs.Attach(connID, env)
		report.ConnectionID = connID
		return report, nil
	}},
	"connection/disconnect": {conn: true, run: func(p *plugin, connID string, _ map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		p.envs.Forget(connID)
		return map[string]any{"success": true}, nil
	}},
	"http/request": {conn: true, run: func(p *plugin, connID string, _ map[string]any, raw json.RawMessage) (any, *dbx.PluginError) {
		return p.doRequest(connID, raw)
	}},
	"cookie/clear": {conn: true, run: func(p *plugin, connID string, _ map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		p.envs.ClearCookies(connID)
		return map[string]any{"ok": true}, nil
	}},
	"collection/list": {conn: true, run: func(p *plugin, connID string, _ map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		items, err := p.collections.List(connID)
		if err != nil {
			return nil, toPluginError(err)
		}
		return map[string]any{"items": items}, nil
	}},
	"collection/save": {conn: true, run: func(p *plugin, connID string, _ map[string]any, raw json.RawMessage) (any, *dbx.PluginError) {
		var req struct {
			Item store.Node `json:"item"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, dbx.NewError(-32602, "接口集合参数无效")
		}
		saved, items, err := p.collections.Save(connID, req.Item)
		if err != nil {
			return nil, toPluginError(err)
		}
		return map[string]any{"items": items, "saved": saved}, nil
	}},
	"collection/delete": {conn: true, run: func(p *plugin, connID string, params map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		items, err := p.collections.Delete(connID, asString(params["id"]))
		if err != nil {
			return nil, toPluginError(err)
		}
		return map[string]any{"items": items}, nil
	}},
	"collection/reorder": {conn: true, run: func(p *plugin, connID string, _ map[string]any, raw json.RawMessage) (any, *dbx.PluginError) {
		var req struct {
			ParentID string   `json:"parentId"`
			IDs      []string `json:"ids"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, dbx.NewError(-32602, "接口集合参数无效")
		}
		items, err := p.collections.Reorder(connID, req.ParentID, req.IDs)
		if err != nil {
			return nil, toPluginError(err)
		}
		return map[string]any{"items": items}, nil
	}},
	"collection/import-openapi": {conn: true, run: func(p *plugin, connID string, params map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		folderID, count, err := p.collections.ImportOpenAPI(connID, asString(params["document"]))
		if err != nil {
			return nil, toPluginError(err)
		}
		items, err := p.collections.List(connID)
		if err != nil {
			return nil, toPluginError(err)
		}
		return map[string]any{"items": items, "folderId": folderID, "created": count}, nil
	}},
	"history/list": {conn: true, run: func(p *plugin, connID string, params map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		limit := 50
		if n, ok := params["limit"].(float64); ok && n > 0 {
			limit = int(n)
		}
		items, err := p.history.List(connID, limit)
		if err != nil {
			return nil, toPluginError(err)
		}
		return map[string]any{"items": items}, nil
	}},
	"history/get": {conn: true, run: func(p *plugin, connID string, params map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		entryID := asString(params["id"])
		if entryID == "" {
			return nil, dbx.NewError(-32602, "缺少 id")
		}
		item, ok, err := p.history.Get(connID, entryID)
		if err != nil {
			return nil, toPluginError(err)
		}
		if !ok {
			return nil, dbx.NewError(-32602, "历史记录不存在")
		}
		return map[string]any{"item": item}, nil
	}},
	"history/delete": {conn: true, run: func(p *plugin, connID string, params map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		items, err := p.history.Delete(connID, asString(params["id"]))
		if err != nil {
			return nil, toPluginError(err)
		}
		return map[string]any{"items": items}, nil
	}},
	"history/clear": {conn: true, run: func(p *plugin, connID string, _ map[string]any, _ json.RawMessage) (any, *dbx.PluginError) {
		items, err := p.history.Clear(connID)
		if err != nil {
			return nil, toPluginError(err)
		}
		return map[string]any{"items": items}, nil
	}},
}

// Handle is the single entry point the host calls. Order matters: unknown
// methods fail before params are touched, then params are decoded and their
// connectionId fields validated, and only then does the route run.
func (p *plugin) Handle(_ dbx.RequestContext, method string, raw json.RawMessage, _ *dbx.Emitter) (any, *dbx.PluginError) {
	route, known := rpcRoutes[method]
	if !known {
		return nil, dbx.MethodNotFound(method)
	}
	params, rawObj, perr := decodeParams(raw)
	if perr != nil {
		return nil, perr
	}
	if perr = checkConnectionIDFields(params); perr != nil {
		return nil, perr
	}
	connID := ""
	if route.conn {
		connID = connection.ResolveConnectionID(params)
		if connID == "" {
			return nil, dbx.NewError(-32602, "缺少 connectionId")
		}
	}
	return route.run(p, connID, params, rawObj)
}

// decodeParams accepts absent params and JSON null, normalizing both to "{}"
// so handlers can rely on an object and on a non-empty raw.
func decodeParams(raw json.RawMessage) (map[string]any, json.RawMessage, *dbx.PluginError) {
	params := map[string]any{}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, nil, dbx.NewError(-32602, "JSON 参数无效")
		}
	}
	if len(raw) == 0 || string(raw) == "null" {
		raw = json.RawMessage("{}")
	}
	return params, raw, nil
}

// checkConnectionIDFields rejects a non-string connectionId early — JSON
// decoders happily hand back a float64, and every downstream lookup expects
// the string the workbench actually sends.
func checkConnectionIDFields(params map[string]any) *dbx.PluginError {
	for _, key := range []string{"connectionId", "connection_id"} {
		if value, ok := params[key]; ok {
			if _, isString := value.(string); !isString {
				return dbx.NewError(-32602, key+" 必须是字符串")
			}
		}
	}
	return nil
}

func asString(v any) string { s, _ := v.(string); return s }

// asInt64 reads a JSON number. Every integer on the wire arrives as a float64,
// and an absent or non-numeric value reads as 0, which the callers treat as
// "not specified".
func asInt64(v any) int64 {
	n, _ := v.(float64)
	return int64(n)
}

// doRequest runs one HTTP call and files the whole exchange — the parameters
// that went out, the response that came back, when it happened — into the
// connection's history.
func (p *plugin) doRequest(connID string, raw json.RawMessage) (any, *dbx.PluginError) {
	env, err := p.envs.Fetch(connID)
	if err != nil {
		return nil, toPluginError(err)
	}
	var spec rest.RequestSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return nil, dbx.NewError(-32602, "请求参数无效")
	}
	timeout := env.Timeout
	if spec.Settings.TimeoutMs > 0 {
		timeout = time.Duration(min(spec.Settings.TimeoutMs, rest.MaxTimeoutMs)) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout+5*time.Second)
	defer cancel()
	base := toBaseEnv(env)
	base.Files = p.uploads
	resp, err := rest.Send(ctx, base, spec)
	if err != nil {
		return nil, toPluginError(err)
	}
	spec.Method = strings.ToUpper(strings.TrimSpace(spec.Method))
	_ = p.history.Add(connID, store.Snapshot(spec, resp))
	return resp, nil
}

// toBaseEnv narrows the live connection down to what the HTTP client may see.
func toBaseEnv(env *connection.Env) rest.BaseEnv {
	wire := rest.BaseEnv{
		BaseURL:     env.BaseURL,
		AuthType:    env.AuthType,
		Token:       env.Token,
		Username:    env.Username,
		Password:    env.Password,
		InsecureTLS: env.InsecureTLS,
		Proxy:       env.Proxy,
	}
	// A typed nil must not reach the interface, or the client would call into
	// a jar that does not exist.
	if env.Cookies != nil {
		wire.Cookies = env.Cookies
	}
	return wire
}

func runCurlParse(params map[string]any) (any, *dbx.PluginError) {
	command := asString(params["command"])
	if strings.TrimSpace(command) == "" {
		return nil, dbx.NewError(-32602, "命令不能为空")
	}
	spec, err := rest.ParseCurl(command)
	if err != nil {
		return nil, dbx.NewError(-32602, err.Error())
	}
	return map[string]any{"item": spec}, nil
}

// readClipboard serves paste. The workbench UI runs in a sandboxed iframe and
// cannot reach the system clipboard, so the sidecar does it instead.
func readClipboard() (any, *dbx.PluginError) {
	text, err := clipboard.Read(context.Background())
	if err != nil {
		return nil, toPluginError(err)
	}
	return map[string]any{"text": text}, nil
}

func writeClipboard(params map[string]any) (any, *dbx.PluginError) {
	text, ok := params["text"].(string)
	if !ok {
		return nil, dbx.NewError(-32602, "text 必须是字符串")
	}
	if err := clipboard.Write(context.Background(), text); err != nil {
		return nil, toPluginError(err)
	}
	return map[string]any{"success": true}, nil
}

// toPluginError converts a domain error into the JSON-RPC error the host
// displays. Network and timeout failures stay retryable; validation failures
// are recognized by the marker table below and surface as invalid_params.
func toPluginError(err error) *dbx.PluginError {
	if err == nil {
		return nil
	}
	var netErr net.Error
	kind, retryable, rpcCode := "internal", false, -32000
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		kind, retryable = "timeout", true
	case errors.Is(err, context.Canceled):
		kind = "canceled"
	case errors.As(err, &netErr):
		kind, retryable = "network", true
	case strings.Contains(err.Error(), "连接尚未建立"):
		kind = "not_connected"
	default:
		for _, marker := range validationMarkers {
			if strings.Contains(err.Error(), marker) {
				kind, rpcCode = "invalid_params", -32602
				break
			}
		}
	}
	return &dbx.PluginError{
		Code:    rpcCode,
		Message: err.Error(),
		Data:    map[string]any{"code": kind, "retryable": retryable},
	}
}

// validationMarkers: 领域层的校验错误以普通 error 返回，靠这些标记统一映射为
// invalid_params。改错误文案时需同步这张表。
var validationMarkers = []string{
	"不能为空", "请填写", "必须", "只能", "不支持", "无效", "解析失败", "不存在", "不能把", "缺少 URL", "无法打开表单文件", "无法读取二进制请求体",
}

func main() {
	uploads, err := upload.New("")
	if err != nil {
		panic(err)
	}
	defer uploads.Close()
	p := &plugin{
		envs:        connection.New(),
		collections: &store.Collections{},
		history:     &store.History{},
		uploads:     uploads,
	}
	server := dbx.NewServer(resolveMetadata(), p)
	if err := server.Serve(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		panic(err)
	}
}
