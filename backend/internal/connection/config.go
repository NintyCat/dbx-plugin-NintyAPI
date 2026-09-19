package connection

import (
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Env is everything a request needs once a connection is live. It exists only
// in memory: tokens and passwords must never reach disk, logs, or events.
type Env struct {
	ID          string
	BaseURL     string
	AuthType    string // "", "none", "bearer", "basic"
	Token       string
	Username    string
	Password    string
	Timeout     time.Duration
	InsecureTLS bool
	Proxy       string
	// Cookies is the connection's session store, attached by the Manager.
	Cookies *Jar
}

func asMap(v any) map[string]any { m, _ := v.(map[string]any); return m }

func asString(v any) string { s, _ := v.(string); return s }

// ResolveConnectionID accepts both shapes the workbench sends: the flat
// connectionId and the nested connection object older hosts hydrate.
func ResolveConnectionID(params map[string]any) string {
	if id := asString(params["connectionId"]); id != "" {
		return id
	}
	return asString(asMap(params["connection"])["id"])
}

// Resolve builds an Env from the payload DBX hands over for a connection.
// Plain fields are looked up in external_config / config (or config_json for
// older hosts), then the connection object, then the flat params. Credentials
// are only ever taken from connection_secrets or the top levels — never from
// the shared config blocks, which may travel through more hands.
func Resolve(params map[string]any) (*Env, error) {
	conn := asMap(params["connection"])
	config := asMap(conn["external_config"])
	if config == nil {
		config = asMap(conn["config"])
	}
	if config == nil {
		if encoded := asString(conn["config_json"]); encoded != "" {
			config = map[string]any{}
			if err := json.Unmarshal([]byte(encoded), &config); err != nil {
				return nil, errors.New("连接配置解析失败")
			}
		}
	}
	plain := func(key string) string {
		for _, table := range []map[string]any{config, conn, params} {
			if v := asString(table[key]); v != "" {
				return v
			}
		}
		return ""
	}
	credentials := func(key string) string {
		if v := asString(asMap(conn["connection_secrets"])[key]); v != "" {
			return v
		}
		for _, table := range []map[string]any{conn, params} {
			if v := asString(table[key]); v != "" {
				return v
			}
		}
		return ""
	}
	env := &Env{
		ID:       ResolveConnectionID(params),
		AuthType: strings.ToLower(strings.TrimSpace(plain("auth_type"))),
		Token:    credentials("token"),
		Username: plain("username"),
		Password: credentials("password"),
		Proxy:    plain("proxy"),
		Timeout:  30 * time.Second,
	}
	if base := strings.TrimRight(strings.TrimSpace(plain("base_url")), "/"); base != "" {
		u, err := url.Parse(base)
		if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
			return nil, errors.New("base_url 必须是不带凭据的 http(s) 地址")
		}
		env.BaseURL = base
	} else if server := strings.TrimRight(strings.TrimSpace(plain("server")), "/"); server != "" {
		u, err := url.Parse(server)
		if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
			return nil, errors.New("base_url 必须是不带凭据的 http(s) 地址")
		}
		env.BaseURL = server
	}
	if raw := plain("timeout_s"); raw != "" {
		seconds, err := strconv.Atoi(raw)
		if err != nil || seconds < 1 || seconds > 300 {
			return nil, errors.New("timeout_s 必须在 1 到 300 之间")
		}
		env.Timeout = time.Duration(seconds) * time.Second
	} else if seconds, ok := config["timeout_s"].(float64); ok {
		if seconds < 1 || seconds > 300 || seconds != float64(int(seconds)) {
			return nil, errors.New("timeout_s 必须在 1 到 300 之间")
		}
		env.Timeout = time.Duration(seconds) * time.Second
	}
	switch env.AuthType {
	case "", "none", "bearer", "basic":
	default:
		return nil, errors.New("auth_type 只能是 bearer 或 basic")
	}
	if env.AuthType == "bearer" && env.Token == "" {
		return nil, errors.New("Bearer 认证需要填写 Token")
	}
	if env.AuthType == "basic" && env.Username == "" {
		return nil, errors.New("Basic 认证需要填写用户名")
	}
	if env.Proxy != "" {
		u, err := url.Parse(env.Proxy)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5") {
			return nil, errors.New("代理必须是 http(s) 或 socks5 地址")
		}
	}
	env.InsecureTLS = insecureFlag(config, plain)
	return env, nil
}

// insecureFlag reads the TLS opt-out from the typed config when present, and
// falls back to the string form on the lookup chain.
func insecureFlag(config map[string]any, plain func(string) string) bool {
	if b, ok := config["insecure_skip_tls_verify"].(bool); ok {
		return b
	}
	return plain("insecure_skip_tls_verify") == "true"
}
