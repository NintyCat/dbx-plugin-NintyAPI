package rest

import "testing"

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
