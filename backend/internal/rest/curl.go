package rest

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// ParseCurl turns a cURL command line into a request draft. It covers the
// flags people actually paste: method, headers, data, form fields, basic
// auth, insecure TLS, follow redirects and timeouts.
func ParseCurl(command string) (RequestSpec, error) {
	tokens, err := tokenize(strings.TrimSpace(command))
	if err != nil {
		return RequestSpec{}, err
	}
	if len(tokens) > 0 && strings.EqualFold(tokens[0], "curl") {
		tokens = tokens[1:]
	}
	spec := RequestSpec{Method: http.MethodGet}
	var dataParts []string
	var formFields []KV
	var user, agent, referer, cookie string
	var insecure, follow, head, get bool
	var maxSeconds int

	next := func(i int, flag string) (string, error) {
		if i+1 >= len(tokens) {
			return "", fmt.Errorf("参数 %s 缺少值", flag)
		}
		return tokens[i+1], nil
	}
	for i := 0; i < len(tokens); i++ {
		tok := tokens[i]
		switch tok {
		case "-X", "--request":
			value, err := next(i, tok)
			if err != nil {
				return RequestSpec{}, err
			}
			i++
			spec.Method = strings.ToUpper(value)
		case "-H", "--header":
			value, err := next(i, tok)
			if err != nil {
				return RequestSpec{}, err
			}
			i++
			name, headerValue, found := strings.Cut(value, ":")
			if !found {
				return RequestSpec{}, fmt.Errorf("无效的请求头 %q", value)
			}
			spec.Headers = append(spec.Headers, KV{Key: strings.TrimSpace(name), Value: strings.TrimSpace(headerValue)})
		case "-d", "--data", "--data-raw", "--data-ascii", "--data-binary":
			value, err := next(i, tok)
			if err != nil {
				return RequestSpec{}, err
			}
			i++
			dataParts = append(dataParts, value)
		case "--data-urlencode", "-F", "--form":
			value, err := next(i, tok)
			if err != nil {
				return RequestSpec{}, err
			}
			i++
			name, fieldValue, found := strings.Cut(value, "=")
			if !found {
				if tok == "--data-urlencode" {
					name, fieldValue = "data", value
				} else {
					return RequestSpec{}, fmt.Errorf("无效的表单字段 %q", value)
				}
			}
			formFields = append(formFields, KV{Key: name, Value: fieldValue})
		case "-u", "--user":
			if user, err = next(i, tok); err != nil {
				return RequestSpec{}, err
			}
			i++
		case "-A", "--user-agent":
			if agent, err = next(i, tok); err != nil {
				return RequestSpec{}, err
			}
			i++
		case "-e", "--referer":
			if referer, err = next(i, tok); err != nil {
				return RequestSpec{}, err
			}
			i++
		case "-b", "--cookie":
			if cookie, err = next(i, tok); err != nil {
				return RequestSpec{}, err
			}
			i++
		case "-m", "--max-time":
			value, err := next(i, tok)
			if err != nil {
				return RequestSpec{}, err
			}
			i++
			if seconds, convErr := strconv.Atoi(value); convErr == nil && seconds > 0 {
				maxSeconds = seconds
			}
		case "-k", "--insecure":
			insecure = true
		case "-L", "--location":
			follow = true
		case "-I", "--head":
			head = true
		case "-G", "--get":
			get = true
		case "-s", "-S", "-v", "-i", "-f", "--silent", "--compressed", "--include", "--fail":
			// output-control flags: nothing to import
		case "":
		default:
			if strings.HasPrefix(tok, "-") {
				break // unknown flag or short-flag cluster: ignored
			}
			if spec.URL == "" {
				spec.URL = tok
			}
		}
	}
	setHeader := func(name, value string) {
		if value == "" {
			return
		}
		for j := range spec.Headers {
			if strings.EqualFold(spec.Headers[j].Key, name) {
				spec.Headers[j].Value = value
				return
			}
		}
		spec.Headers = append(spec.Headers, KV{Key: name, Value: value})
	}
	setHeader("User-Agent", agent)
	setHeader("Referer", referer)
	if cookie != "" {
		setHeader("Cookie", cookie)
	}
	if head {
		spec.Method = http.MethodHead
	}
	if user != "" {
		name, password, _ := strings.Cut(user, ":")
		spec.Auth = &AuthSpec{Type: "basic", Username: name, Password: password}
	}
	if len(formFields) > 0 {
		kind := "form"
		if anyFileField(formFields) {
			kind = "multipart"
		}
		spec.Body = &BodySpec{Type: kind, Fields: formFields}
		if spec.Method == http.MethodGet {
			spec.Method = http.MethodPost
		}
	} else if len(dataParts) > 0 {
		data := strings.Join(dataParts, "&")
		if get {
			separator := "?"
			if strings.Contains(spec.URL, "?") {
				separator = "&"
			}
			spec.URL += separator + data
		} else {
			spec.Body = bodyForData(headerValue(spec.Headers, "Content-Type"), data)
			if spec.Method == http.MethodGet {
				spec.Method = http.MethodPost
			}
		}
	}
	settings := Settings{VerifyTLS: boolPtr(!insecure), FollowRedirects: boolPtr(follow)}
	if maxSeconds > 0 {
		settings.TimeoutMs = min(maxSeconds*1000, MaxTimeoutMs)
	}
	spec.Settings = settings
	if spec.URL == "" {
		return RequestSpec{}, errors.New("cURL 命令中缺少 URL")
	}
	return spec, nil
}

// bodyForData picks the editor that can hold a --data payload: a file
// reference becomes a binary body, JSON, XML and urlencoded payloads get their
// own editors, and anything else stays raw text. The Content-Type header wins
// when it names a known type; otherwise the content is sniffed.
func bodyForData(contentType, data string) *BodySpec {
	if path, ok := referencedFile(data); ok {
		return &BodySpec{Type: "binary", Content: path}
	}
	mediaType := strings.TrimSpace(strings.ToLower(strings.SplitN(contentType, ";", 2)[0]))
	content := strings.TrimSpace(data)
	switch {
	case mediaType == "application/json" || strings.HasSuffix(mediaType, "+json"):
		return &BodySpec{Type: "json", Content: data}
	case mediaType == "application/xml", mediaType == "text/xml",
		strings.HasSuffix(mediaType, "+xml"):
		return &BodySpec{Type: "xml", Content: data}
	case mediaType == "application/x-www-form-urlencoded":
		if fields, ok := urlencodedFields(data); ok {
			return &BodySpec{Type: "form", Fields: fields}
		}
	case mediaType != "":
		// A declared type none of our editors model: keep the payload intact.
		return &BodySpec{Type: "raw", Content: data}
	}
	// Nothing declared, so the payload itself has to say what it is.
	switch {
	case looksJSON(content):
		return &BodySpec{Type: "json", Content: data}
	case strings.HasPrefix(content, "<"):
		return &BodySpec{Type: "xml", Content: data}
	case looksForm(content):
		if fields, ok := urlencodedFields(data); ok {
			return &BodySpec{Type: "form", Fields: fields}
		}
	}
	return &BodySpec{Type: "raw", Content: data}
}

// referencedFile reports the path of a `--data-binary @file` payload, which the
// binary body type sends straight from disk.
func referencedFile(data string) (string, bool) {
	path, found := strings.CutPrefix(strings.TrimSpace(data), "@")
	path = strings.TrimSpace(path)
	if !found || path == "" || strings.ContainsAny(path, "& \t\n") {
		return "", false
	}
	return path, true
}

// looksJSON accepts payloads that parse, and ones that merely open like JSON:
// broken JSON is exactly what the JSON editor is there to fix.
func looksJSON(content string) bool {
	if content == "" {
		return false
	}
	return json.Valid([]byte(content)) ||
		strings.HasPrefix(content, "{") || strings.HasPrefix(content, "[")
}

// looksForm recognises a bare `k=v&k=v` payload that carries no content type
// saying so. Whitespace rules out prose that merely mentions an equals sign.
func looksForm(content string) bool {
	if content == "" || !strings.Contains(content, "=") || strings.ContainsAny(content, " \t\n\r") {
		return false
	}
	for _, pair := range strings.Split(content, "&") {
		if key, _, found := strings.Cut(pair, "="); !found || key == "" {
			return false
		}
	}
	return true
}

// urlencodedFields turns `k=v&k=v` into rows, undoing the percent-encoding so
// sending them re-encodes to exactly the payload that was pasted.
func urlencodedFields(data string) ([]KV, bool) {
	var fields []KV
	for _, pair := range strings.Split(data, "&") {
		if pair == "" {
			continue
		}
		key, value, found := strings.Cut(pair, "=")
		if !found {
			return nil, false
		}
		decodedKey, err := url.QueryUnescape(key)
		if err != nil {
			return nil, false
		}
		decodedValue, err := url.QueryUnescape(value)
		if err != nil {
			return nil, false
		}
		fields = append(fields, KV{Key: decodedKey, Value: decodedValue})
	}
	return fields, len(fields) > 0
}

func headerValue(headers []KV, name string) string {
	for _, header := range headers {
		if strings.EqualFold(header.Key, name) {
			return header.Value
		}
	}
	return ""
}

func anyFileField(fields []KV) bool {
	for _, f := range fields {
		if strings.HasPrefix(f.Value, "@") {
			return true
		}
	}
	return false
}

func boolPtr(v bool) *bool { return &v }

// tokenize splits a command line into words, honouring single quotes, double
// quotes and backslash escapes.
func tokenize(line string) ([]string, error) {
	var tokens []string
	var current strings.Builder
	started := false
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case c == '\'':
			started = true
			end := strings.IndexByte(line[i+1:], '\'')
			if end < 0 {
				return nil, errors.New("单引号未闭合")
			}
			current.WriteString(line[i+1 : i+1+end])
			i += end + 1
		case c == '"':
			started = true
			i++
			for i < len(line) && line[i] != '"' {
				if line[i] == '\\' && i+1 < len(line) {
					i++
				}
				current.WriteByte(line[i])
				i++
			}
			if i >= len(line) {
				return nil, errors.New("双引号未闭合")
			}
		case c == '\\' && i+1 < len(line):
			started = true
			i++
			current.WriteByte(line[i])
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			if started {
				tokens = append(tokens, current.String())
				current.Reset()
				started = false
			}
		default:
			started = true
			current.WriteByte(c)
		}
	}
	if started {
		tokens = append(tokens, current.String())
	}
	return tokens, nil
}
