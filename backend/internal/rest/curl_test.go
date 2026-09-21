package rest

import (
	"strings"
	"testing"
)

// An imported cURL should land in the body editor that matches what was sent:
// the type decides which fields the UI shows and how the body goes back out.
func TestParseCurlPicksTheBodyType(t *testing.T) {
	for _, tt := range []struct {
		name     string
		command  string
		wantType string
		wantBody string   // content for text bodies
		wantKeys []string // field keys for form bodies
	}{
		{
			name:     "json object",
			command:  `curl -X POST https://api.example.com/users -d '{"name":"张三"}'`,
			wantType: "json",
			wantBody: `{"name":"张三"}`,
		},
		{
			name:     "json array",
			command:  `curl https://api.example.com/users -d '[1,2,3]'`,
			wantType: "json",
			wantBody: `[1,2,3]`,
		},
		{
			name:     "broken json still opens the json editor",
			command:  `curl https://api.example.com/users -d '{name: "张三"}'`,
			wantType: "json",
			wantBody: `{name: "张三"}`,
		},
		{
			name:     "xml by content",
			command:  `curl -X POST https://api.example.com/x -d '<user><name>张三</name></user>'`,
			wantType: "xml",
			wantBody: `<user><name>张三</name></user>`,
		},
		{
			name:     "content type wins over sniffing",
			command:  `curl https://api.example.com/x -H 'Content-Type: application/xml' -d '{"not":"xml"}'`,
			wantType: "xml",
			wantBody: `{"not":"xml"}`,
		},
		{
			name:     "urlencoded with content type",
			command:  `curl https://api.example.com/x -H 'Content-Type: application/x-www-form-urlencoded' -d 'user=%E5%BC%A0%E4%B8%89&page=2'`,
			wantType: "form",
			wantKeys: []string{"user", "page"},
		},
		{
			name:     "urlencoded without content type",
			command:  `curl https://api.example.com/x -d 'a=1&b=2'`,
			wantType: "form",
			wantKeys: []string{"a", "b"},
		},
		{
			name:     "prose stays raw",
			command:  `curl https://api.example.com/x -d 'hello world, a=b'`,
			wantType: "raw",
			wantBody: `hello world, a=b`,
		},
		{
			name:     "data-binary from a file",
			command:  `curl https://api.example.com/x --data-binary @payload.json`,
			wantType: "binary",
			wantBody: `payload.json`,
		},
		{
			name:     "form fields",
			command:  `curl https://api.example.com/x -F 'name=张三' -F 'page=2'`,
			wantType: "form",
			wantKeys: []string{"name", "page"},
		},
		{
			name:     "multipart when a field is a file",
			command:  `curl https://api.example.com/x -F 'name=张三' -F 'avatar=@a.png'`,
			wantType: "multipart",
			wantKeys: []string{"name", "avatar"},
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			spec, err := ParseCurl(tt.command)
			if err != nil {
				t.Fatal(err)
			}
			if spec.Body == nil {
				t.Fatalf("no body parsed: %#v", spec)
			}
			if spec.Body.Type != tt.wantType {
				t.Fatalf("type = %q, want %q", spec.Body.Type, tt.wantType)
			}
			if tt.wantBody != "" && spec.Body.Content != tt.wantBody {
				t.Fatalf("content = %q, want %q", spec.Body.Content, tt.wantBody)
			}
			if len(tt.wantKeys) > 0 {
				var keys []string
				for _, field := range spec.Body.Fields {
					keys = append(keys, field.Key)
				}
				if len(keys) != len(tt.wantKeys) {
					t.Fatalf("fields = %v, want %v", keys, tt.wantKeys)
				}
				for i, key := range tt.wantKeys {
					if keys[i] != key {
						t.Fatalf("fields = %v, want %v", keys, tt.wantKeys)
					}
				}
			}
		})
	}
}

// A -F field that names a file becomes a file row carrying the path, which is
// what the form editor renders and what the sender opens.
func TestParseCurlTurnsFileFieldsIntoFileRows(t *testing.T) {
	spec, err := ParseCurl(`curl https://api.example.com/x -F 'name=张三' -F 'avatar=@/tmp/a.png'`)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Body.Type != "multipart" {
		t.Fatalf("type = %q, want multipart", spec.Body.Type)
	}
	text, file := spec.Body.Fields[0], spec.Body.Fields[1]
	if text.Kind != "text" || text.Value != "张三" {
		t.Fatalf("text row = %#v", text)
	}
	if file.Kind != "file" {
		t.Fatalf("file row kind = %q, want file", file.Kind)
	}
	if len(file.Files) != 1 || file.Files[0].Path != "/tmp/a.png" {
		t.Fatalf("file row = %#v, want the path from the command", file)
	}
	// The value is not a file path once it has been read as one, or the sender
	// would see a text row spelling "@..." as well.
	if file.Value != "" {
		t.Fatalf("file row kept a text value: %q", file.Value)
	}
}

func TestParseCurlDecodesUrlencodedValues(t *testing.T) {
	spec, err := ParseCurl(`curl https://api.example.com/x -d 'user=%E5%BC%A0%E4%B8%89&note=a+b'`)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Body.Type != "form" || len(spec.Body.Fields) != 2 {
		t.Fatalf("bad body: %#v", spec.Body)
	}
	if spec.Body.Fields[0].Value != "张三" || spec.Body.Fields[1].Value != "a b" {
		t.Fatalf("values not decoded: %#v", spec.Body.Fields)
	}
}

// -G keeps the payload in the query string, so there is no body to place.
func TestParseCurlGetKeepsNoBody(t *testing.T) {
	spec, err := ParseCurl(`curl -G https://api.example.com/x -d 'a=1' -d 'b={"c":2}'`)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Body != nil {
		t.Fatalf("expected no body: %#v", spec.Body)
	}
	if spec.URL != `https://api.example.com/x?a=1&b={"c":2}` {
		t.Fatalf("payload missing from url: %q", spec.URL)
	}
}

// The real-world shape: a body copied out of a browser's network panel. It
// arrives as one ANSI-C-quoted --data-raw holding the whole multipart payload,
// its file part is empty because DevTools never had the bytes, and every line
// but the last ends in a shell continuation.
const browserCopiedImport = "curl --url 'http://10.10.102.34:32441/regulatoryApi/api/BaInstitutionInfoAtt/import' \\\n" +
	"  -H 'Accept: application/json, text/plain, */*' \\\n" +
	"  -H 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8' \\\n" +
	"  -H 'Authorization: Bearer b462bac4-39d7-41ea-84e9-be46400f5821' \\\n" +
	"  -H 'Connection: keep-alive' \\\n" +
	"  -H 'Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryq18MKyOqJAHnpr5c' \\\n" +
	"  -H 'Origin: http://10.10.102.34:32441' \\\n" +
	"  -H 'User-Agent: Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/153.0.0.0' \\\n" +
	"  --data-raw $'------WebKitFormBoundaryq18MKyOqJAHnpr5c\\r\\nContent-Disposition: form-data; name=\"file\"; filename=\"检测机构模版-2026-09-20-18-49-22.xlsx\"\\r\\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\\r\\n\\r\\n\\r\\n------WebKitFormBoundaryq18MKyOqJAHnpr5c--\\r\\n' \\\n" +
	"  --insecure"

// A pasted multipart body becomes form rows the editor can work with, instead of
// one raw blob whose boundary nothing regenerates.
func TestParseCurlReadsABrowserCopiedMultipartBody(t *testing.T) {
	spec, err := ParseCurl(browserCopiedImport)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Body == nil || spec.Body.Type != "multipart" {
		t.Fatalf("body = %#v, want multipart", spec.Body)
	}
	if len(spec.Body.Fields) != 1 {
		t.Fatalf("fields = %#v, want one file row", spec.Body.Fields)
	}
	row := spec.Body.Fields[0]
	if row.Key != "file" || row.Kind != "file" {
		t.Fatalf("row = %#v, want a file row named file", row)
	}
	if len(row.Files) != 1 {
		t.Fatalf("row carries %d files, want 1", len(row.Files))
	}
	file := row.Files[0]
	if file.Name != "检测机构模版-2026-09-20-18-49-22.xlsx" {
		t.Fatalf("filename = %q", file.Name)
	}
	if file.ContentType != "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" {
		t.Fatalf("part content type = %q", file.ContentType)
	}
	// The bytes were never in the command, so the row must not pretend to have
	// them — no path and no upload id means the workbench asks for a file.
	if file.Path != "" || file.ID != "" {
		t.Fatalf("row claims to have bytes it cannot have: %#v", file)
	}
}

// The copied boundary names a delimiter the sender will never write, so the
// header has to go: the assembled body picks its own.
func TestParseCurlDropsTheCopiedBoundaryHeader(t *testing.T) {
	spec, err := ParseCurl(browserCopiedImport)
	if err != nil {
		t.Fatal(err)
	}
	if got := headerValue(spec.Headers, "Content-Type"); got != "" {
		t.Fatalf("Content-Type survived as %q, want it dropped", got)
	}
	// The headers that still matter are kept — including the ones after the
	// dropped Content-Type, which is where a mishandled line continuation shows
	// up first.
	if got := headerValue(spec.Headers, "Authorization"); got != "Bearer b462bac4-39d7-41ea-84e9-be46400f5821" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := headerValue(spec.Headers, "Origin"); got != "http://10.10.102.34:32441" {
		t.Fatalf("Origin = %q, want the header after Content-Type", got)
	}
	if got := headerValue(spec.Headers, "User-Agent"); !strings.Contains(got, "Chrome/153") {
		t.Fatalf("User-Agent = %q", got)
	}
	// --insecure is on the last line, past four continuations.
	if spec.Settings.VerifyTLS == nil || *spec.Settings.VerifyTLS {
		t.Fatal("--insecure did not survive the continuations")
	}
}

// A backslash at the end of a line joins it to the next one; it is not an
// escaped newline, and leaking one as a token swallows the flag that follows.
func TestTokenizeJoinsContinuedLines(t *testing.T) {
	tokens, err := tokenize("curl \\\n  -H 'A: b' \\\r\n  --insecure")
	if err != nil {
		t.Fatal(err)
	}
	for _, token := range tokens {
		if strings.ContainsAny(token, "\r\n") {
			t.Fatalf("token %q carries a line break", token)
		}
	}
	want := []string{"curl", "-H", "A: b", "--insecure"}
	if len(tokens) != len(want) {
		t.Fatalf("tokens = %q, want %q", tokens, want)
	}
	for i, token := range want {
		if tokens[i] != token {
			t.Fatalf("tokens = %q, want %q", tokens, want)
		}
	}
}

// A multipart payload with real text fields keeps them as text rows.
func TestParseCurlReadsMultipartTextFields(t *testing.T) {
	cmd := `curl https://api.example.com/x ` +
		`-H 'Content-Type: multipart/form-data; boundary=XX' ` +
		`--data-raw $'--XX\r\nContent-Disposition: form-data; name="name"\r\n\r\n张三\r\n` +
		`--XX\r\nContent-Disposition: form-data; name="avatar"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n\r\n--XX--\r\n'`
	spec, err := ParseCurl(cmd)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Body.Type != "multipart" || len(spec.Body.Fields) != 2 {
		t.Fatalf("body = %#v", spec.Body)
	}
	if spec.Body.Fields[0].Key != "name" || spec.Body.Fields[0].Value != "张三" {
		t.Fatalf("text row = %#v", spec.Body.Fields[0])
	}
	if spec.Body.Fields[0].Kind != "text" {
		t.Fatalf("kind = %q, want text", spec.Body.Fields[0].Kind)
	}
	if len(spec.Body.Fields[1].Files) != 1 || spec.Body.Fields[1].Files[0].Name != "a.png" {
		t.Fatalf("file row = %#v", spec.Body.Fields[1])
	}
}

// A multipart body pasted without its Content-Type header is still recognised by
// its opening delimiter.
func TestParseCurlSpotsMultipartWithoutAHeader(t *testing.T) {
	cmd := `curl https://api.example.com/x ` +
		`--data-raw $'--BB\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--BB--\r\n'`
	spec, err := ParseCurl(cmd)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Body.Type != "multipart" || len(spec.Body.Fields) != 1 {
		t.Fatalf("body = %#v, want one multipart field", spec.Body)
	}
	if spec.Body.Fields[0].Value != "1" {
		t.Fatalf("value = %q", spec.Body.Fields[0].Value)
	}
}

// A declared multipart type whose body does not parse must stay raw, so a
// half-converted payload never goes out.
func TestParseCurlLeavesAnUnparseableMultipartBodyRaw(t *testing.T) {
	cmd := `curl https://api.example.com/x -H 'Content-Type: multipart/form-data; boundary=XX' --data-raw 'not a multipart body'`
	spec, err := ParseCurl(cmd)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Body.Type != "raw" {
		t.Fatalf("type = %q, want raw", spec.Body.Type)
	}
}

// ANSI-C quoting is the only reason a pasted body has real newlines at all.
func TestTokenizeDecodesAnsiCQuoting(t *testing.T) {
	tokens, err := tokenize(`curl x --data-raw $'a\r\nb\tc\\d\x41'`)
	if err != nil {
		t.Fatal(err)
	}
	want := "a\r\nb\tc\\dA"
	if tokens[len(tokens)-1] != want {
		t.Fatalf("token = %q, want %q", tokens[len(tokens)-1], want)
	}
}

func TestTokenizeKeepsAnUnknownEscape(t *testing.T) {
	tokens, err := tokenize(`x $'a\qb'`)
	if err != nil {
		t.Fatal(err)
	}
	if tokens[len(tokens)-1] != `a\qb` {
		t.Fatalf("token = %q, want the backslash kept", tokens[len(tokens)-1])
	}
}

// A pasted body with several parts under one field name keeps them in one row,
// in order — the shape a multiple file input produces.
func TestParseCurlKeepsRepeatedFilePartsInOneRow(t *testing.T) {
	cmd := `curl https://api.example.com/x ` +
		`-H 'Content-Type: multipart/form-data; boundary=XX' ` +
		`--data-raw $'--XX\r\nContent-Disposition: form-data; name="file"; filename="a.xlsx"\r\nContent-Type: application/vnd.ms-excel\r\n\r\nAAA\r\n` +
		`--XX\r\nContent-Disposition: form-data; name="file"; filename="b.xlsx"\r\nContent-Type: application/vnd.ms-excel\r\n\r\nBBB\r\n--XX--\r\n'`
	spec, err := ParseCurl(cmd)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Body.Type != "multipart" {
		t.Fatalf("type = %q", spec.Body.Type)
	}
	if len(spec.Body.Fields) != 1 {
		t.Fatalf("fields = %#v, want one row holding both files", spec.Body.Fields)
	}
	row := spec.Body.Fields[0]
	if len(row.Files) != 2 {
		t.Fatalf("row holds %d files, want 2", len(row.Files))
	}
	if row.Files[0].Name != "a.xlsx" || row.Files[1].Name != "b.xlsx" {
		t.Fatalf("order = %q, %q", row.Files[0].Name, row.Files[1].Name)
	}
	// The text a part carried is dropped: these are file parts, and their bytes
	// came from the server's clipboard, not from a real file.
	if row.Value != "" {
		t.Fatalf("row kept a text value: %q", row.Value)
	}
}

// Repeated -F flags naming the same field with files fold into one row too,
// matching what the editor shows for a field carrying several files.
func TestParseCurlFoldsRepeatedFileFlags(t *testing.T) {
	spec, err := ParseCurl(`curl https://api.example.com/x -F 'file=@a.xlsx' -F 'file=@b.xlsx' -F 'note=hi'`)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Body.Type != "multipart" {
		t.Fatalf("type = %q", spec.Body.Type)
	}
	if len(spec.Body.Fields) != 2 {
		t.Fatalf("fields = %#v, want a file row and a text row", spec.Body.Fields)
	}
	row := spec.Body.Fields[0]
	if row.Key != "file" || len(row.Files) != 2 {
		t.Fatalf("file row = %#v", row)
	}
	if row.Files[0].Path != "a.xlsx" || row.Files[1].Path != "b.xlsx" {
		t.Fatalf("paths = %q, %q", row.Files[0].Path, row.Files[1].Path)
	}
	if spec.Body.Fields[1].Key != "note" || spec.Body.Fields[1].Value != "hi" {
		t.Fatalf("text row = %#v", spec.Body.Fields[1])
	}
}

// Text fields keep repeating as separate rows: two values under one name is a
// different thing from one field holding several files, and collapsing them
// would lose a value.
func TestParseCurlKeepsRepeatedTextFieldsApart(t *testing.T) {
	spec, err := ParseCurl(`curl https://api.example.com/x -d 'a=1&a=2'`)
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.Body.Fields) != 2 {
		t.Fatalf("fields = %#v, want both values kept", spec.Body.Fields)
	}
}
