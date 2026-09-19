package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/NintyCat/dbx-plugin-NintyAPI/internal/rest"
)

func TestSnapshotKeepsRequestAndResponse(t *testing.T) {
	spec := rest.RequestSpec{
		Method:      "POST",
		URL:         "/users",
		QueryParams: []rest.KV{{Key: "page", Value: "2"}},
		Headers:     []rest.KV{{Key: "X-Trace", Value: "abc"}},
		Auth:        &rest.AuthSpec{Type: "bearer", Token: "tk"},
		Body:        &rest.BodySpec{Type: "json", Content: `{"name":"张三"}`},
	}
	resp := &rest.Response{Status: 201, URL: "https://api.example.com/users?page=2", Body: `{"id":1}`}
	record := Snapshot(spec, resp)
	if record.CreatedAt.IsZero() {
		t.Fatal("expected a timestamp")
	}
	if record.Request.Auth.Token != "tk" || record.Request.Body.Content != `{"name":"张三"}` {
		t.Fatalf("request not recorded in full: %#v", record.Request)
	}
	if record.Response == nil || record.Response.Status != 201 || record.Response.Body != `{"id":1}` {
		t.Fatalf("response not recorded: %#v", record.Response)
	}
	row := record.Summary()
	if row.Method != "POST" || row.Status != 201 || row.URL != "https://api.example.com/users?page=2" {
		t.Fatalf("bad summary: %#v", row)
	}
	if row.ResponseBodyOmitted {
		t.Fatal("nothing was trimmed")
	}
}

func TestSnapshotTrimsOversizedBodies(t *testing.T) {
	big := strings.Repeat("a", maxStoredBody+5000)
	resp := &rest.Response{Status: 200, Body: big}
	record := Snapshot(rest.RequestSpec{Method: "GET", URL: "/big", Body: &rest.BodySpec{Type: "raw", Content: big}}, resp)
	if len(record.Request.Body.Content) != maxStoredBody || !record.RequestBodyOmitted {
		t.Fatalf("request body not capped: %d bytes", len(record.Request.Body.Content))
	}
	if len(record.Response.Body) != maxStoredBody || !record.ResponseBodyOmitted || !record.Response.Truncated {
		t.Fatalf("response body not capped: %d bytes", len(record.Response.Body))
	}
	if len(resp.Body) != len(big) {
		t.Fatal("the caller's response must stay intact for rendering")
	}
}

func TestSnapshotCutsOnRuneBoundary(t *testing.T) {
	// Three-byte runes straddling the cap would otherwise leave a replacement
	// character at the end of the stored body.
	body := strings.Repeat("中", maxStoredBody/3+10)
	record := Snapshot(rest.RequestSpec{Method: "GET"}, &rest.Response{Body: body})
	cut := record.Response.Body
	if strings.ContainsRune(cut, '\uFFFD') {
		t.Fatalf("cut left a replacement character: %q", cut[len(cut)-8:])
	}
	if len(cut) > maxStoredBody {
		t.Fatalf("cut is over the cap: %d", len(cut))
	}
}

func TestHistoryRoundTrip(t *testing.T) {
	h := NewHistory(filepath.Join(t.TempDir(), "history.json"))
	first := Record{Request: rest.RequestSpec{Method: "GET", URL: "/a"}}
	if err := h.Add("conn", first); err != nil {
		t.Fatal(err)
	}
	if err := h.Add("conn", Record{Request: rest.RequestSpec{Method: "POST", URL: "/b"}}); err != nil {
		t.Fatal(err)
	}
	rows, err := h.List("conn", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].URL != "/b" || rows[1].URL != "/a" {
		t.Fatalf("newest must come first: %#v", rows)
	}
	if rows[1].ID == "" || rows[1].CreatedAt.IsZero() {
		t.Fatalf("missing identity: %#v", rows[1])
	}
	record, ok, err := h.Get("conn", rows[1].ID)
	if err != nil || !ok || record.Request.URL != "/a" {
		t.Fatalf("get failed: %#v %v %v", record, ok, err)
	}
	if _, ok, _ = h.Get("conn", "missing"); ok {
		t.Fatal("expected a miss for an unknown id")
	}
	remaining, err := h.Delete("conn", rows[1].ID)
	if err != nil || len(remaining) != 1 || remaining[0].URL != "/b" {
		t.Fatalf("delete failed: %#v %v", remaining, err)
	}
	if _, err = h.Clear("conn"); err != nil {
		t.Fatal(err)
	}
	// Entries survive a reload, so the file has to carry the new shape.
	if rows, err = h.List("conn", 10); err != nil || len(rows) != 0 {
		t.Fatalf("clear did not stick: %#v %v", rows, err)
	}
}

func TestHistoryReadsLegacyEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.json")
	legacy := `{"conn":[{"id":"abc","method":"GET","url":"https://api.example.com/x","status":200,` +
		`"timeMs":12,"createdAt":"2026-01-02T03:04:05Z"}]}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	h := NewHistory(path)
	rows, err := h.List("conn", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Method != "GET" || rows[0].URL != "https://api.example.com/x" || rows[0].Status != 200 {
		t.Fatalf("legacy row lost: %#v", rows)
	}
	if !rows[0].CreatedAt.Equal(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)) {
		t.Fatalf("legacy timestamp lost: %v", rows[0].CreatedAt)
	}
	record, ok, err := h.Get("conn", "abc")
	if err != nil || !ok || record.Request.URL != "https://api.example.com/x" {
		t.Fatalf("legacy detail lost: %#v %v %v", record, ok, err)
	}
}
