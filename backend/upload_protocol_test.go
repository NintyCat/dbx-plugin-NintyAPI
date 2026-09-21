package main

import (
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// These tests drive the upload routes through Handle, the same entry point the
// host calls, so they cover the wire contract the workbench actually speaks:
// upload/begin, then upload/chunk per slice, then http/request naming the
// upload. The UI's side of that contract is asserted in the vitest suite.

// uploadInChunks streams body to the sidecar the way the workbench does and
// returns the id it was given.
func uploadInChunks(t *testing.T, c *rpcClient, name, contentType, body string, chunk int) string {
	t.Helper()
	begin, perr := c.call("upload/begin", fmt.Sprintf(
		`{"name":%q,"contentType":%q,"size":%d}`, name, contentType, len(body)))
	if perr != nil {
		t.Fatalf("upload/begin: %v", perr)
	}
	uploadID := begin.(map[string]any)["uploadId"].(string)

	for offset := 0; offset < len(body); offset += chunk {
		end := min(offset+chunk, len(body))
		params := fmt.Sprintf(`{"uploadId":%q,"offset":%d,"data":%q}`,
			uploadID, offset, base64.StdEncoding.EncodeToString([]byte(body[offset:end])))
		if _, perr := c.call("upload/chunk", params); perr != nil {
			t.Fatalf("upload/chunk at %d: %v", offset, perr)
		}
	}
	return uploadID
}

// readMultipart returns each part of a multipart body by field name.
type wirePart struct {
	value       string
	filename    string
	contentType string
	body        []byte
}

func readMultipart(t *testing.T, r *http.Request) map[string]wirePart {
	t.Helper()
	_, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		t.Fatalf("content type %q: %v", r.Header.Get("Content-Type"), err)
	}
	reader := multipart.NewReader(r.Body, params["boundary"])
	out := map[string]wirePart{}
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
		out[part.FormName()] = wirePart{
			value:       string(body),
			filename:    part.FileName(),
			contentType: part.Header.Get("Content-Type"),
			body:        body,
		}
	}
}

// The whole point of the feature, end to end: a file the workbench streamed in
// chunks comes back out of the request as a properly named and typed part.
func TestUploadedFileTravelsAsAMultipartPart(t *testing.T) {
	var got map[string]wirePart
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = readMultipart(t, r)
	}))
	defer server.Close()

	c := newTestPlugin(t)
	// Two and a half chunks, so the reassembly is exercised rather than a
	// single write.
	fileBody := strings.Repeat("NintyAPI-", 600)
	uploadID := uploadInChunks(t, c, "报表.pdf", "application/pdf", fileBody, 2000)

	spec := fmt.Sprintf(`{"connectionId":"test","method":"POST","url":%q,
		"body":{"type":"multipart","fields":[
			{"key":"title","value":"月度报表","kind":"text"},
			{"key":"attachment","kind":"file","file":{"id":%q,"name":"报表.pdf","contentType":"application/pdf"}}]}}`,
		server.URL, uploadID)
	if _, perr := c.call("http/request", spec); perr != nil {
		t.Fatalf("http/request: %v", perr)
	}

	if got["title"].value != "月度报表" {
		t.Fatalf("text field = %q", got["title"].value)
	}
	attachment := got["attachment"]
	if string(attachment.body) != fileBody {
		t.Fatalf("file arrived as %d bytes, want %d", len(attachment.body), len(fileBody))
	}
	if attachment.filename != "报表.pdf" {
		t.Fatalf("filename = %q, want 报表.pdf", attachment.filename)
	}
	if attachment.contentType != "application/pdf" {
		t.Fatalf("part content type = %q, want application/pdf", attachment.contentType)
	}
}

// A picked file is also the binary body, where the bytes are the whole request.
func TestUploadedFileTravelsAsABinaryBody(t *testing.T) {
	var got []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
	}))
	defer server.Close()

	c := newTestPlugin(t)
	payload := strings.Repeat("binary-payload-", 300)
	uploadID := uploadInChunks(t, c, "blob.bin", "application/octet-stream", payload, 1024)

	spec := fmt.Sprintf(`{"connectionId":"test","method":"POST","url":%q,
		"body":{"type":"binary","file":{"id":%q,"name":"blob.bin"}}}`, server.URL, uploadID)
	if _, perr := c.call("http/request", spec); perr != nil {
		t.Fatalf("http/request: %v", perr)
	}
	if string(got) != payload {
		t.Fatalf("body arrived as %d bytes, want %d", len(got), len(payload))
	}
}

// Sending a file the sidecar no longer holds must fail loudly, not silently send
// an empty part that the server would accept.
func TestSendingAnUnknownUploadIsRefused(t *testing.T) {
	c := newTestPlugin(t)
	_, perr := c.call("http/request", `{"connectionId":"test","method":"POST","url":"http://example.invalid/x",
		"body":{"type":"multipart","fields":[{"key":"f","kind":"file","file":{"id":"gone"}}]}}`)
	if perr == nil {
		t.Fatal("an unknown upload must not send")
	}
	if !strings.Contains(perr.Message, "不存在") {
		t.Fatalf("message = %q, want it to say the file is gone", perr.Message)
	}
	// The workbench renders this inline, so it has to read as a bad parameter
	// rather than an internal failure.
	if perr.Code != -32602 {
		t.Fatalf("code = %d, want -32602", perr.Code)
	}
}

// A half-sent file is worse than a failure: the server would store a truncated
// upload and report success.
func TestAnIncompleteUploadIsRefused(t *testing.T) {
	c := newTestPlugin(t)
	begin, perr := c.call("upload/begin", `{"name":"a.bin","contentType":"application/octet-stream","size":10}`)
	if perr != nil {
		t.Fatal(perr)
	}
	uploadID := begin.(map[string]any)["uploadId"].(string)
	if _, perr := c.call("upload/chunk", fmt.Sprintf(
		`{"uploadId":%q,"offset":0,"data":%q}`, uploadID,
		base64.StdEncoding.EncodeToString([]byte("abc")))); perr != nil {
		t.Fatal(perr)
	}

	_, perr = c.call("http/request", fmt.Sprintf(`{"connectionId":"test","method":"POST","url":"http://example.invalid/x",
		"body":{"type":"binary","file":{"id":%q,"name":"a.bin"}}}`, uploadID))
	if perr == nil {
		t.Fatal("a partial upload must not send")
	}
	if !strings.Contains(perr.Message, "不完整") {
		t.Fatalf("message = %q, want it to say the upload is incomplete", perr.Message)
	}
}

// A chunk that arrives out of order means one was lost; accepting it would
// corrupt the file silently.
func TestAReplayedChunkIsRefused(t *testing.T) {
	c := newTestPlugin(t)
	begin, perr := c.call("upload/begin", `{"name":"a.bin","contentType":"application/octet-stream","size":8}`)
	if perr != nil {
		t.Fatal(perr)
	}
	uploadID := begin.(map[string]any)["uploadId"].(string)
	chunk := fmt.Sprintf(`{"uploadId":%q,"offset":0,"data":%q}`, uploadID,
		base64.StdEncoding.EncodeToString([]byte("abcd")))
	if _, perr := c.call("upload/chunk", chunk); perr != nil {
		t.Fatal(perr)
	}
	_, perr = c.call("upload/chunk", chunk)
	if perr == nil {
		t.Fatal("a replayed chunk must be refused")
	}
	if !strings.Contains(perr.Message, "顺序") {
		t.Fatalf("message = %q, want it to name the ordering", perr.Message)
	}
}

// The workbench abandons an upload it can no longer use, so a cancelled send
// does not leave the file on disk.
func TestAbortDropsTheUpload(t *testing.T) {
	c := newTestPlugin(t)
	uploadID := uploadInChunks(t, c, "a.bin", "application/octet-stream", "hello", 1024)
	if _, perr := c.call("upload/abort", fmt.Sprintf(`{"uploadId":%q}`, uploadID)); perr != nil {
		t.Fatal(perr)
	}
	_, perr := c.call("http/request", fmt.Sprintf(`{"connectionId":"test","method":"POST","url":"http://example.invalid/x",
		"body":{"type":"binary","file":{"id":%q,"name":"a.bin"}}}`, uploadID))
	if perr == nil {
		t.Fatal("an aborted upload must not send")
	}
}

// A file over the cap is refused when it is declared, before any chunk travels.
func TestAnOversizedFileIsRefusedUpFront(t *testing.T) {
	c := newTestPlugin(t)
	_, perr := c.call("upload/begin", fmt.Sprintf(
		`{"name":"huge.bin","contentType":"application/octet-stream","size":%d}`, 64<<20+1))
	if perr == nil {
		t.Fatal("a file over the cap must be refused")
	}
	if !strings.Contains(perr.Message, "超过") {
		t.Fatalf("message = %q, want it to name the cap", perr.Message)
	}
}

// The workbench sends base64, so a malformed payload is a client bug worth
// naming rather than a decode error leaking through.
func TestAMalformedChunkIsRefused(t *testing.T) {
	c := newTestPlugin(t)
	begin, perr := c.call("upload/begin", `{"name":"a.bin","contentType":"application/octet-stream","size":4}`)
	if perr != nil {
		t.Fatal(perr)
	}
	uploadID := begin.(map[string]any)["uploadId"].(string)
	_, perr = c.call("upload/chunk", fmt.Sprintf(`{"uploadId":%q,"offset":0,"data":"not base64!"}`, uploadID))
	if perr == nil {
		t.Fatal("a malformed chunk must be refused")
	}
	if perr.Code != -32602 {
		t.Fatalf("code = %d, want -32602", perr.Code)
	}
}

// The routes must not require a connection: the workbench streams bytes before
// it has a request to attach them to.
func TestUploadRoutesNeedNoConnection(t *testing.T) {
	c := newTestPlugin(t)
	if _, perr := c.call("upload/begin", `{"name":"a.bin","contentType":"text/plain","size":0}`); perr != nil {
		t.Fatalf("upload/begin needs no connection, got %v", perr)
	}
	// A connectionId that is not a string is still rejected everywhere.
	if _, perr := c.call("upload/begin", `{"connectionId":3,"name":"a.bin","size":0}`); perr == nil {
		t.Fatal("a non-string connectionId must be rejected")
	}
}

// Uploads are streamed, not stored: sending the same request twice uploads once
// and the second send reuses the bytes that are already there.
func TestAnUploadCanBeSentTwice(t *testing.T) {
	received := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) == "repeatable" {
			received++
		}
	}))
	defer server.Close()

	c := newTestPlugin(t)
	uploadID := uploadInChunks(t, c, "a.bin", "text/plain", "repeatable", 1024)
	spec := fmt.Sprintf(`{"connectionId":"test","method":"POST","url":%q,
		"body":{"type":"binary","file":{"id":%q,"name":"a.bin"}}}`, server.URL, uploadID)
	for i := 0; i < 2; i++ {
		if _, perr := c.call("http/request", spec); perr != nil {
			t.Fatalf("send %d: %v", i+1, perr)
		}
	}
	if received != 2 {
		t.Fatalf("server saw %d sends, want 2", received)
	}
}
