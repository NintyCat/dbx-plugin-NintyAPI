package rest

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
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
	var formFields []FormField
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
			formFields = append(formFields, formFieldFromCurl(name, fieldValue))
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
		spec.Body = &BodySpec{Type: kind, Fields: foldFileRows(formFields)}
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
			if spec.Body != nil && spec.Body.Type == "multipart" {
				// The sender writes its own boundary when it assembles the body,
				// so the copied one would name a delimiter that never appears.
				spec.Headers = dropHeader(spec.Headers, "Content-Type")
			}
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
	case strings.HasPrefix(mediaType, "multipart/"):
		if fields, ok := multipartFields(contentType, data); ok {
			return &BodySpec{Type: "multipart", Fields: fields}
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
	case looksMultipart(content):
		if fields, ok := multipartFields("", data); ok {
			return &BodySpec{Type: "multipart", Fields: fields}
		}
	case looksForm(content):
		if fields, ok := urlencodedFields(data); ok {
			return &BodySpec{Type: "form", Fields: fields}
		}
	}
	return &BodySpec{Type: "raw", Content: data}
}

// multipartFields reads a multipart payload that arrived as a pasted body rather
// than as -F flags, which is the shape a browser's "copy as cURL" produces.
//
// The file bytes were never in the clipboard — DevTools writes the part headers
// and leaves the content empty — so a file part becomes a file row that carries
// the filename and still has to be filled in. That is the honest reading: the
// alternative is sending a zero-byte file and calling it success.
func multipartFields(contentType, data string) ([]FormField, bool) {
	boundary := boundaryOf(contentType)
	if boundary == "" {
		// No header to read it from, so take it from the opening delimiter.
		if _, rest, found := strings.Cut(data, "--"); found {
			if end := strings.IndexAny(rest, "\r\n"); end > 0 {
				boundary = rest[:end]
			}
		}
	}
	if boundary == "" {
		return nil, false
	}
	reader := multipart.NewReader(strings.NewReader(data), boundary)
	var fields []FormField
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			// A body that does not parse is not a multipart body; leave it raw
			// rather than half-converting it.
			return nil, false
		}
		body, err := io.ReadAll(part)
		if err != nil {
			return nil, false
		}
		name := part.FormName()
		if name == "" {
			return nil, false
		}
		if filename := part.FileName(); filename != "" {
			fields = append(fields, FormField{
				Key:  name,
				Kind: "file",
				Files: []FileRef{{
					Name:        filename,
					ContentType: part.Header.Get("Content-Type"),
				}},
			})
			continue
		}
		fields = append(fields, FormField{Key: name, Value: string(body), Kind: "text"})
	}
	if len(fields) == 0 {
		return nil, false
	}
	return foldFileRows(fields), true
}

// foldFileRows merges file parts that share a field name into one row. That is
// how the editor models a field carrying several files, and it is what both a
// multiple file input and repeated `-F name=@file` flags mean.
func foldFileRows(fields []FormField) []FormField {
	out := make([]FormField, 0, len(fields))
	for _, field := range fields {
		last := len(out) - 1
		if last >= 0 && field.Kind == "file" && out[last].Kind == "file" && out[last].Key == field.Key {
			out[last].Files = append(out[last].Files, field.Files...)
			continue
		}
		out = append(out, field)
	}
	return out
}

// boundaryOf pulls the boundary out of a multipart Content-Type. It is read by
// hand rather than with mime.ParseMediaType because a boundary that came from
// the clipboard is often unquoted and carries characters ParseMediaType
// rejects.
func boundaryOf(contentType string) string {
	for _, param := range strings.Split(contentType, ";")[1:] {
		key, value, found := strings.Cut(strings.TrimSpace(param), "=")
		if !found || !strings.EqualFold(key, "boundary") {
			continue
		}
		return strings.Trim(strings.TrimSpace(value), `"`)
	}
	return ""
}

// looksMultipart spots a pasted body by its opening delimiter, which is all
// there is to go on when the Content-Type header was dropped along the way.
func looksMultipart(content string) bool {
	return strings.HasPrefix(content, "--") && strings.Contains(content, "Content-Disposition:")
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
func urlencodedFields(data string) ([]FormField, bool) {
	var fields []FormField
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
		fields = append(fields, FormField{Key: decodedKey, Value: decodedValue, Kind: "text"})
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

// dropHeader removes every row naming a header, for the headers the sender
// generates itself.
func dropHeader(headers []KV, name string) []KV {
	kept := make([]KV, 0, len(headers))
	for _, header := range headers {
		if strings.EqualFold(header.Key, name) {
			continue
		}
		kept = append(kept, header)
	}
	return kept
}

// formFieldFromCurl reads one -F field. A "@" value is a file, which the
// editor shows as a file row carrying the path; the multipart type follows from
// there. The display name is left unset so the sender can take it from the
// path itself.
func formFieldFromCurl(name, value string) FormField {
	if file, found := strings.CutPrefix(strings.TrimSpace(value), "@"); found && file != "" {
		return FormField{Key: name, Kind: "file", Files: []FileRef{{Path: file}}}
	}
	return FormField{Key: name, Value: value, Kind: "text"}
}

func anyFileField(fields []FormField) bool {
	for _, f := range fields {
		if len(f.fileRefs()) > 0 {
			return true
		}
	}
	return false
}

func boolPtr(v bool) *bool { return &v }

// tokenize splits a command line into words, honouring single quotes, double
// quotes, ANSI-C quoting and backslash escapes.
func tokenize(line string) ([]string, error) {
	var tokens []string
	var current strings.Builder
	started := false
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case c == '$' && i+1 < len(line) && line[i+1] == '\'':
			// ANSI-C quoting, which is how a shell-ready paste spells a payload
			// with real newlines in it — a multipart body copied out of the
			// browser arrives exactly this way.
			started = true
			end := strings.IndexByte(line[i+2:], '\'')
			if end < 0 {
				return nil, errors.New("ANSI-C 引号未闭合")
			}
			decoded, err := unescapeAnsiC(line[i+2 : i+2+end])
			if err != nil {
				return nil, err
			}
			current.WriteString(decoded)
			i += end + 2
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
		case c == '\\' && i+1 < len(line) && (line[i+1] == '\n' || line[i+1] == '\r'):
			// A shell line continuation: the lines are one command, and the
			// backslash-newline pair belongs to no argument. Treating it as an
			// escaped newline would leak a stray "\n" token that swallows the
			// flag after it — which is exactly how a multi-line paste loses
			// headers.
			i++
			if line[i] == '\r' && i+1 < len(line) && line[i+1] == '\n' {
				i++
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

// unescapeAnsiC expands the backslash escapes a $'...' literal may carry. The
// ones a pasted HTTP body actually uses are the whitespace escapes; the rest are
// here so a decoded payload is never silently wrong.
func unescapeAnsiC(text string) (string, error) {
	var out strings.Builder
	for i := 0; i < len(text); i++ {
		if text[i] != '\\' || i+1 >= len(text) {
			out.WriteByte(text[i])
			continue
		}
		i++
		switch text[i] {
		case 'n':
			out.WriteByte('\n')
		case 'r':
			out.WriteByte('\r')
		case 't':
			out.WriteByte('\t')
		case 'a':
			out.WriteByte('\a')
		case 'b':
			out.WriteByte('\b')
		case 'f':
			out.WriteByte('\f')
		case 'v':
			out.WriteByte('\v')
		case '\\', '\'', '"', '?':
			out.WriteByte(text[i])
		case 'x':
			if i+2 >= len(text) {
				return "", errors.New("\\x 转义不完整")
			}
			value, err := strconv.ParseUint(text[i+1:i+3], 16, 8)
			if err != nil {
				return "", fmt.Errorf("无效的 \\x 转义 %q", text[i+1:i+3])
			}
			out.WriteByte(byte(value))
			i += 2
		default:
			// An escape with no meaning keeps its backslash, which is what a
			// shell does too.
			out.WriteByte('\\')
			out.WriteByte(text[i])
		}
	}
	return out.String(), nil
}
