package rest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// readParts parses a multipart request body into the values and files it
// carried, so a test can assert on what the server actually received rather
// than on the bytes we meant to send.
type receivedPart struct {
	value       string
	filename    string
	contentType string
	body        []byte
}

func readParts(t *testing.T, r *http.Request) map[string]receivedPart {
	t.Helper()
	mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || !strings.HasPrefix(mediaType, "multipart/") {
		t.Fatalf("content type = %q, want multipart", r.Header.Get("Content-Type"))
	}
	reader := multipart.NewReader(r.Body, params["boundary"])
	out := map[string]receivedPart{}
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(part)
		if err != nil {
			t.Fatal(err)
		}
		name := part.FormName()
		// A repeated field keeps the last one, which is enough for these cases.
		out[name] = receivedPart{
			value:       string(body),
			filename:    part.FileName(),
			contentType: part.Header.Get("Content-Type"),
			body:        body,
		}
	}
}

// The whole point of the file route: a form field the user picked a file for
// travels as a file part, named and typed, next to the plain text fields.
func TestMultipartSendsAPickedFile(t *testing.T) {
	var got map[string]receivedPart
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = readParts(t, r)
	}))
	defer server.Close()

	resp, err := Send(context.Background(), BaseEnv{Files: resolverFor("up-1", "hello from disk")}, RequestSpec{
		Method: http.MethodPost,
		URL:    server.URL,
		Body: &BodySpec{Type: "multipart", Fields: []FormField{
			{Key: "name", Value: "张三", Kind: "text"},
			{Key: "avatar", Kind: "file", Files: []FileRef{{
				ID: "up-1", Name: "头像.png", ContentType: "image/png",
			}}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Status != http.StatusOK {
		t.Fatalf("status = %d", resp.Status)
	}
	if got["name"].value != "张三" {
		t.Fatalf("text field = %q", got["name"].value)
	}
	avatar := got["avatar"]
	if string(avatar.body) != "hello from disk" {
		t.Fatalf("file bytes = %q", avatar.body)
	}
	if avatar.filename != "头像.png" {
		t.Fatalf("filename = %q, want 头像.png", avatar.filename)
	}
	if avatar.contentType != "image/png" {
		t.Fatalf("part content type = %q, want image/png", avatar.contentType)
	}
}

// A cURL import stores the path in the value as "@path". It has to keep working
// without the editor ever having seen it.
func TestMultipartReadsAtPathAsAFile(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(file, []byte("from a path"), 0o600); err != nil {
		t.Fatal(err)
	}
	var got map[string]receivedPart
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = readParts(t, r)
	}))
	defer server.Close()

	_, err := Send(context.Background(), BaseEnv{}, RequestSpec{
		Method: http.MethodPost,
		URL:    server.URL,
		Body: &BodySpec{Type: "multipart", Fields: []FormField{
			{Key: "attachment", Value: "@" + file},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(got["attachment"].body) != "from a path" {
		t.Fatalf("file bytes = %q", got["attachment"].body)
	}
	if got["attachment"].filename != "notes.txt" {
		t.Fatalf("filename = %q, want notes.txt", got["attachment"].filename)
	}
	if got["attachment"].contentType != "application/octet-stream" {
		t.Fatalf("part content type = %q", got["attachment"].contentType)
	}
}

// A row the editor marked as text is text, even when its value opens with "@":
// an email address or a handle must not turn into a file read.
func TestMultipartKeepsATextRowThatStartsWithAt(t *testing.T) {
	var got map[string]receivedPart
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = readParts(t, r)
	}))
	defer server.Close()

	_, err := Send(context.Background(), BaseEnv{}, RequestSpec{
		Method: http.MethodPost,
		URL:    server.URL,
		Body: &BodySpec{Type: "multipart", Fields: []FormField{
			{Key: "contact", Value: "@someone", Kind: "text"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got["contact"].value != "@someone" {
		t.Fatalf("value = %q, want @someone", got["contact"].value)
	}
	if got["contact"].filename != "" {
		t.Fatalf("text row arrived as a file: %q", got["contact"].filename)
	}
}

// A picked file's bytes are only in the upload store, so a store that no longer
// has them must fail loudly rather than send an empty part.
func TestMultipartFailsWhenTheUploadIsGone(t *testing.T) {
	_, err := Send(context.Background(), BaseEnv{Files: resolverFor("other", "x")}, RequestSpec{
		Method: http.MethodPost,
		URL:    "http://example.invalid/",
		Body: &BodySpec{Type: "multipart", Fields: []FormField{
			{Key: "avatar", Kind: "file", Files: []FileRef{{ID: "up-1", Name: "a.png"}}},
		}},
	})
	if err == nil {
		t.Fatal("a missing upload must not send")
	}
	if !strings.Contains(err.Error(), "不存在") {
		t.Fatalf("error = %v, want it to say the file is gone", err)
	}
}

// The binary body carries a picked file's bytes verbatim.
func TestBinarySendsAPickedFile(t *testing.T) {
	payload := []byte{0x00, 0x01, 0xff, 0xfe}
	var got []byte
	var gotType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
		gotType = r.Header.Get("Content-Type")
	}))
	defer server.Close()

	_, err := Send(context.Background(), BaseEnv{Files: resolverFor("up-2", string(payload))}, RequestSpec{
		Method: http.MethodPost,
		URL:    server.URL,
		Body:   &BodySpec{Type: "binary", File: &FileRef{ID: "up-2", Name: "blob.bin"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("body = %v, want %v", got, payload)
	}
	if gotType != "application/octet-stream" {
		t.Fatalf("content type = %q", gotType)
	}
}

// A binary body saved before file picking existed holds a path in Content, and
// those requests have to keep sending.
func TestBinaryStillReadsAPathFromContent(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "payload.bin")
	if err := os.WriteFile(file, []byte("legacy"), 0o600); err != nil {
		t.Fatal(err)
	}
	var got []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
	}))
	defer server.Close()

	_, err := Send(context.Background(), BaseEnv{}, RequestSpec{
		Method: http.MethodPost,
		URL:    server.URL,
		Body:   &BodySpec{Type: "binary", Content: file},
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "legacy" {
		t.Fatalf("body = %q, want legacy", got)
	}
}

// A part filename is attacker-controlled text from a picker, so a newline in it
// must not be able to start a new header line inside the multipart body.
func TestPartFilenameCannotInjectHeaders(t *testing.T) {
	if got := escapePartName("a\"b\\c\r\nX-Injected: 1"); strings.ContainsAny(got, "\r\n") {
		t.Fatalf("escaped name = %q, want no line breaks", got)
	}
}

// resolverFor is a FileResolver over one in-memory upload, standing in for the
// sidecar's store.
func resolverFor(id, body string) FileResolver {
	return stubResolver{id: id, body: body}
}

type stubResolver struct {
	id   string
	body string
}

func (s stubResolver) Open(ref FileRef) (io.ReadCloser, error) {
	if ref.ID != s.id {
		return nil, errUploadGone
	}
	return io.NopCloser(strings.NewReader(s.body)), nil
}

var errUploadGone = errUploadNotFound{}

type errUploadNotFound struct{}

func (errUploadNotFound) Error() string {
	return "上传的文件不存在或已过期，请重新选择文件"
}

// A hand-typed or pasted multipart Content-Type names a boundary that appears
// nowhere in the assembled body. Sending it would make the server fail to find a
// single part, so the writer's own boundary has to win.
func TestAStaleBoundaryHeaderIsReplaced(t *testing.T) {
	var got map[string]receivedPart
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// readParts fails the test if the declared boundary does not parse.
		got = readParts(t, r)
	}))
	defer server.Close()

	_, err := Send(context.Background(), BaseEnv{}, RequestSpec{
		Method: http.MethodPost,
		URL:    server.URL,
		Headers: []KV{{
			Key:   "Content-Type",
			Value: "multipart/form-data; boundary=----WebKitFormBoundaryq18MKyOqJAHnpr5c",
		}},
		Body: &BodySpec{Type: "multipart", Fields: []FormField{
			{Key: "name", Value: "张三", Kind: "text"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got["name"].value != "张三" {
		t.Fatalf("field = %q, want the body to have parsed", got["name"].value)
	}
}

// A Content-Type the editor wrote for a non-multipart body is still respected:
// the override exists for the boundary, not to take the header away.
func TestATypedContentTypeStillWinsForOtherBodies(t *testing.T) {
	var gotType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotType = r.Header.Get("Content-Type")
	}))
	defer server.Close()

	_, err := Send(context.Background(), BaseEnv{}, RequestSpec{
		Method:  http.MethodPost,
		URL:     server.URL,
		Headers: []KV{{Key: "Content-Type", Value: "application/json; charset=gbk"}},
		Body:    &BodySpec{Type: "json", Content: `{"a":1}`},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotType != "application/json; charset=gbk" {
		t.Fatalf("content type = %q, want the typed one", gotType)
	}
}

// readPartList returns every part in the order it appeared, which a map cannot
// do: several files under one field name are told apart only by their order.
func readPartList(t *testing.T, r *http.Request) []receivedPart {
	t.Helper()
	_, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		t.Fatal(err)
	}
	reader := multipart.NewReader(r.Body, params["boundary"])
	var out []receivedPart
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(part)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, receivedPart{
			filename:    part.FileName(),
			contentType: part.Header.Get("Content-Type"),
			body:        body,
			value:       string(body),
		})
	}
}

// Several files under one field name is how a browser sends a multiple file
// input, and how the workbench sends a row the user filled with several files.
// The parts must all carry that name, in the order the files were chosen.
func TestSeveralFilesShareOneFieldName(t *testing.T) {
	var parts []receivedPart
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts = readPartList(t, r)
	}))
	defer server.Close()

	files := resolverForMany(map[string]string{
		"up-1": "first",
		"up-2": "second",
		"up-3": "third",
	})
	fields := []FormField{}
	for i, name := range []string{"a.xlsx", "b.xlsx", "c.xlsx"} {
		fields = append(fields, FormField{Key: "file", Kind: "file", Files: []FileRef{{
			ID:          fmt.Sprintf("up-%d", i+1),
			Name:        name,
			ContentType: "application/vnd.ms-excel",
		}}})
	}
	_, err := Send(context.Background(), BaseEnv{Files: files}, RequestSpec{
		Method: http.MethodPost,
		URL:    server.URL,
		Body:   &BodySpec{Type: "multipart", Fields: fields},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(parts) != 3 {
		t.Fatalf("parts = %d, want 3", len(parts))
	}
	wantNames := []string{"a.xlsx", "b.xlsx", "c.xlsx"}
	wantBodies := []string{"first", "second", "third"}
	for i, part := range parts {
		if part.filename != wantNames[i] {
			t.Fatalf("part %d filename = %q, want %q", i, part.filename, wantNames[i])
		}
		if part.value != wantBodies[i] {
			t.Fatalf("part %d body = %q, want %q", i, part.value, wantBodies[i])
		}
	}
}

// resolverForMany is a FileResolver over several uploads, standing in for the
// sidecar's store.
func resolverForMany(bodies map[string]string) FileResolver {
	return manyResolver{bodies: bodies}
}

type manyResolver struct{ bodies map[string]string }

func (m manyResolver) Open(ref FileRef) (io.ReadCloser, error) {
	body, ok := m.bodies[ref.ID]
	if !ok {
		return nil, errUploadGone
	}
	return io.NopCloser(strings.NewReader(body)), nil
}

// One field holding several files is the shape the editor now produces, so it
// is the sender that has to turn one row into several parts.
func TestOneRowHoldingSeveralFilesBecomesSeveralParts(t *testing.T) {
	var parts []receivedPart
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts = readPartList(t, r)
	}))
	defer server.Close()

	_, err := Send(context.Background(), BaseEnv{Files: resolverForMany(map[string]string{
		"up-1": "one",
		"up-2": "two",
	})}, RequestSpec{
		Method: http.MethodPost,
		URL:    server.URL,
		Body: &BodySpec{Type: "multipart", Fields: []FormField{
			{Key: "title", Value: "报表", Kind: "text"},
			{Key: "file", Kind: "file", Files: []FileRef{
				{ID: "up-1", Name: "a.xlsx", ContentType: "application/vnd.ms-excel"},
				{ID: "up-2", Name: "b.xlsx", ContentType: "application/vnd.ms-excel"},
			}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(parts) != 3 {
		t.Fatalf("parts = %d, want a text part and two file parts", len(parts))
	}
	if parts[0].value != "报表" {
		t.Fatalf("first part = %q, want the text field", parts[0].value)
	}
	for i, want := range []struct{ name, body string }{{"a.xlsx", "one"}, {"b.xlsx", "two"}} {
		got := parts[i+1]
		if got.filename != want.name || got.value != want.body {
			t.Fatalf("part %d = %q/%q, want %q/%q", i+1, got.filename, got.value, want.name, want.body)
		}
		if got.contentType != "application/vnd.ms-excel" {
			t.Fatalf("part %d content type = %q", i+1, got.contentType)
		}
	}
}

// A row saved before a field could hold several files stores one `file` object.
// It has to keep sending rather than silently dropping the file.
func TestALegacySingleFileRowStillSends(t *testing.T) {
	var got map[string]receivedPart
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = readParts(t, r)
	}))
	defer server.Close()

	// Decoded from the old JSON shape, which is what a stored request holds.
	var body BodySpec
	if err := json.Unmarshal([]byte(`{"type":"multipart","fields":[
		{"key":"avatar","kind":"file","file":{"id":"up-1","name":"old.png","contentType":"image/png"}}]}`), &body); err != nil {
		t.Fatal(err)
	}
	if _, err := Send(context.Background(), BaseEnv{Files: resolverFor("up-1", "legacy bytes")}, RequestSpec{
		Method: http.MethodPost,
		URL:    server.URL,
		Body:   &body,
	}); err != nil {
		t.Fatal(err)
	}
	if got["avatar"].value != "legacy bytes" {
		t.Fatalf("file body = %q", got["avatar"].value)
	}
	if got["avatar"].filename != "old.png" || got["avatar"].contentType != "image/png" {
		t.Fatalf("part = %#v", got["avatar"])
	}
}

// A file row with nothing attached must not go out as an empty text part: the
// server would store a zero-byte upload and report success.
func TestAnEmptyFileRowIsRefused(t *testing.T) {
	_, err := Send(context.Background(), BaseEnv{}, RequestSpec{
		Method: http.MethodPost,
		URL:    "http://example.invalid/",
		Body: &BodySpec{Type: "multipart", Fields: []FormField{
			{Key: "file", Kind: "file"},
		}},
	})
	if err == nil {
		t.Fatal("a file row with no file must not send")
	}
	if !strings.Contains(err.Error(), "不能为空") {
		t.Fatalf("error = %v, want it to name the missing file", err)
	}
}

// An empty text row is still just an empty value, which is a legitimate thing
// for a form to carry.
func TestAnEmptyTextRowStillSends(t *testing.T) {
	var parts []receivedPart
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts = readPartList(t, r)
	}))
	defer server.Close()

	if _, err := Send(context.Background(), BaseEnv{}, RequestSpec{
		Method: http.MethodPost,
		URL:    server.URL,
		Body: &BodySpec{Type: "multipart", Fields: []FormField{
			{Key: "note", Kind: "text"},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if len(parts) != 1 || parts[0].value != "" {
		t.Fatalf("parts = %#v, want one empty text part", parts)
	}
}

// urlencoded has nowhere to put a file. Sending the row as an empty value would
// look to the server like a successful upload of nothing.
func TestAUrlencodedBodyRefusesToDropItsFiles(t *testing.T) {
	_, err := Send(context.Background(), BaseEnv{}, RequestSpec{
		Method: http.MethodPost,
		URL:    "http://example.invalid/",
		Body: &BodySpec{Type: "form", Fields: []FormField{
			{Key: "note", Value: "hi", Kind: "text"},
			{Key: "file", Kind: "file", Files: []FileRef{{Path: "/tmp/a.xlsx"}}},
		}},
	})
	if err == nil {
		t.Fatal("a urlencoded body carrying a file must not send")
	}
	if !strings.Contains(err.Error(), "只能发送文本") {
		t.Fatalf("error = %v, want it to name the encoding", err)
	}
}

// A urlencoded body with a file row that was never filled in is fine: there is
// nothing to lose, so it is simply an empty field.
func TestAUrlencodedBodySendsAnEmptyFileRow(t *testing.T) {
	var got string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got = string(body)
	}))
	defer server.Close()

	if _, err := Send(context.Background(), BaseEnv{}, RequestSpec{
		Method: http.MethodPost,
		URL:    server.URL,
		Body: &BodySpec{Type: "form", Fields: []FormField{
			{Key: "note", Value: "hi", Kind: "text"},
			{Key: "file", Kind: "file"},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if got != "file=&note=hi" {
		t.Fatalf("body = %q", got)
	}
}
