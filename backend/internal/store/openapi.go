package store

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/rest"
)

func boolPtr(v bool) *bool { return &v }

// ImportOpenAPI converts an OpenAPI 3.x / Swagger 2.0 JSON document into a
// collection tree: one folder per tag, one request node per operation. It
// returns the created folder ID so the UI can reveal it afterwards.
func (c *Collections) ImportOpenAPI(connID, document string) (folderID string, count int, err error) {
	doc := map[string]any{}
	if e := json.Unmarshal([]byte(document), &doc); e != nil {
		return "", 0, fmt.Errorf("无效的 JSON 文档：%w", e)
	}
	version := textOf(doc["openapi"])
	if version == "" {
		version = textOf(doc["swagger"])
	}
	if version == "" {
		return "", 0, fmt.Errorf("文档缺少 openapi 或 swagger 版本字段")
	}
	paths, ok := doc["paths"].(map[string]any)
	if !ok {
		return "", 0, fmt.Errorf("文档缺少 paths 部分")
	}
	title := ""
	if info, ok := doc["info"].(map[string]any); ok {
		title = textOf(info["title"])
	}
	if title == "" {
		title = "导入的接口"
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if e := c.ensure(); e != nil {
		return "", 0, e
	}
	existing := c.items[connID]
	if existing == nil {
		existing = map[string]Node{}
	}
	if e := c.checkPathLimit(existing, len(paths)); e != nil {
		return "", 0, e
	}
	now := time.Now()
	folderID = NewID()
	existing[folderID] = Node{
		ID: folderID, Type: "folder", Name: title, CreatedAt: now, UpdatedAt: now,
	}
	folders := map[string]string{}
	methods := []string{"get", "post", "put", "delete", "patch", "head", "options", "trace"}
	for path, rawItem := range paths {
		item, ok := rawItem.(map[string]any)
		if !ok {
			continue
		}
		for _, method := range methods {
			op, ok := item[method].(map[string]any)
			if !ok {
				continue
			}
			tagName := firstTag(op)
			parent := folderID
			if tagName != "" {
				folder, ok := folders[tagName]
				if !ok {
					folder = NewID()
					folders[tagName] = folder
					existing[folder] = Node{ID: folder, ParentID: folderID, Type: "folder", Name: tagName, CreatedAt: now, UpdatedAt: now}
				}
				parent = folder
			}
			name := textOf(op["summary"])
			if name == "" {
				name = textOf(op["operationId"])
			}
			if name == "" {
				name = strings.ToUpper(method) + " " + path
			}
			node := Node{
				ID: NewID(), ParentID: parent, Type: "request",
				Name: name, Method: strings.ToUpper(method), URL: path,
				CreatedAt: now, UpdatedAt: now,
			}
			node.QueryParams, node.Headers = importParameters(op["parameters"])
			if body := importRequestBody(op, version); body != nil {
				node.Body = body
			}
			existing[node.ID] = node
			count++
		}
	}
	next := make(map[string]map[string]Node, len(c.items)+1)
	for k, v := range c.items {
		next[k] = v
	}
	next[connID] = existing
	if e := Save(c.path, next); e != nil {
		return "", 0, e
	}
	c.items = next
	return folderID, count, nil
}

// checkPathLimit guards against pathological imports flooding the store.
func (c *Collections) checkPathLimit(existing map[string]Node, incoming int) error {
	const maxNodes = 5000
	if len(existing)+incoming*4 > maxNodes {
		return fmt.Errorf("接口数量将超过上限 %d", maxNodes)
	}
	return nil
}

func index(m map[string]any, keys ...string) map[string]any {
	current := m
	for _, key := range keys {
		next, ok := current[key].(map[string]any)
		if !ok {
			return nil
		}
		current = next
	}
	return current
}

func textOf(v any) string { s, _ := v.(string); return s }

func firstTag(op map[string]any) string {
	tags, ok := op["tags"].([]any)
	if !ok || len(tags) == 0 {
		return ""
	}
	return strings.TrimSpace(textOf(tags[0]))
}

// importParameters extracts query/header parameters (OpenAPI 3 and Swagger 2
// share this shape closely enough for the common case).
func importParameters(raw any) (query []rest.KV, headers []rest.KV) {
	list, ok := raw.([]any)
	if !ok {
		return nil, nil
	}
	for _, item := range list {
		p, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, where := textOf(p["name"]), textOf(p["in"])
		if name == "" {
			continue
		}
		kv := rest.KV{Key: name, Value: textOf(p["example"]), Enabled: boolPtr(true)}
		if kv.Value == "" {
			if schema, ok := p["schema"].(map[string]any); ok {
				kv.Value = textOf(schema["example"])
				if kv.Value == "" {
					if def, ok := schema["default"].(string); ok {
						kv.Value = def
					}
				}
			}
		}
		switch where {
		case "query":
			query = append(query, kv)
		case "header":
			headers = append(headers, kv)
		}
	}
	return query, headers
}

// importRequestBody builds a JSON body skeleton from the schema when present.
func importRequestBody(op map[string]any, version string) *rest.BodySpec {
	var content map[string]any
	if strings.HasPrefix(version, "3") {
		content = index(op, "requestBody", "content")
	} else {
		// Swagger 2: body parameter carries the schema directly.
		for _, item := range toArray(op["parameters"]) {
			p, ok := item.(map[string]any)
			if !ok || textOf(p["in"]) != "body" {
				continue
			}
			if schema, ok := p["schema"].(map[string]any); ok {
				if sample := schemaExample(schema, 0); sample != "" {
					return &rest.BodySpec{Type: "json", Content: sample}
				}
			}
		}
		return nil
	}
	media, ok := content["application/json"].(map[string]any)
	if !ok {
		return nil
	}
	schema, ok := media["schema"].(map[string]any)
	if !ok {
		return &rest.BodySpec{Type: "json", Content: "{}"}
	}
	if sample := schemaExample(schema, 0); sample != "" {
		return &rest.BodySpec{Type: "json", Content: sample}
	}
	return nil
}

func toArray(v any) []any {
	list, _ := v.([]any)
	return list
}

// schemaExample renders a compact JSON skeleton, preferring declared examples
// and defaults. depth bounds recursion on cyclic schemas.
func schemaExample(schema map[string]any, depth int) string {
	if schema == nil || depth > 8 {
		return "null"
	}
	if ex := textOf(schema["example"]); ex != "" {
		return ex
	}
	if def := schema["default"]; def != nil {
		if encoded, e := json.Marshal(def); e == nil {
			return string(encoded)
		}
	}
	if enums := toArray(schema["enum"]); len(enums) > 0 {
		if encoded, e := json.Marshal(enums[0]); e == nil {
			return string(encoded)
		}
	}
	switch textOf(schema["type"]) {
	case "string":
		return "\"string\""
	case "number", "integer":
		return "0"
	case "boolean":
		return "false"
	case "array":
		return "[" + schemaExample(index(schema, "items"), depth+1) + "]"
	case "object":
		props, ok := schema["properties"].(map[string]any)
		if !ok || len(props) == 0 {
			return "{}"
		}
		keys := make([]string, 0, len(props))
		for key := range props {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			child, _ := props[key].(map[string]any)
			parts = append(parts, fmt.Sprintf("%q:%s", key, schemaExample(child, depth+1)))
		}
		return "{" + strings.Join(parts, ",") + "}"
	}
	return "null"
}
