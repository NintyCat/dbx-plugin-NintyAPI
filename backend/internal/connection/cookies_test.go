package connection

import (
	"net/http"
	"net/url"
	"testing"
)

func siteURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// A login hands out a cookie on one request; the request after it has to carry
// the session, or every call would have to be authenticated by hand.
func TestJarCarriesASessionBetweenRequests(t *testing.T) {
	jar := NewJar()
	jar.SetCookies(siteURL(t, "https://api.example.com/login"), []*http.Cookie{
		{Name: "sid", Value: "s1", Path: "/"},
	})
	got := jar.Cookies(siteURL(t, "https://api.example.com/v1/users"))
	if len(got) != 1 || got[0].Name != "sid" || got[0].Value != "s1" {
		t.Fatalf("session cookie did not travel: %#v", got)
	}
	if other := jar.Cookies(siteURL(t, "https://elsewhere.example/steal")); len(other) != 0 {
		t.Fatalf("a host-only cookie reached another host: %#v", other)
	}
}

func TestJarHonoursThePathItWasGiven(t *testing.T) {
	jar := NewJar()
	jar.SetCookies(siteURL(t, "https://api.example.com/admin/login"), []*http.Cookie{
		{Name: "admin", Value: "1", Path: "/admin"},
	})
	if got := jar.Cookies(siteURL(t, "https://api.example.com/admin/users")); len(got) != 1 {
		t.Fatalf("cookie missing under its own path: %#v", got)
	}
	if got := jar.Cookies(siteURL(t, "https://api.example.com/public")); len(got) != 0 {
		t.Fatalf("cookie leaked outside its path: %#v", got)
	}
}

func TestClearDropsEverything(t *testing.T) {
	jar := NewJar()
	jar.SetCookies(siteURL(t, "https://api.example.com/"), []*http.Cookie{
		{Name: "sid", Value: "s1", Path: "/"},
	})
	jar.Clear()
	if got := jar.Cookies(siteURL(t, "https://api.example.com/")); len(got) != 0 {
		t.Fatalf("jar not empty after clear: %#v", got)
	}
}
