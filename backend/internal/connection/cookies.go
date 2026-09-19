package connection

import (
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"sync"
)

// Jar carries the cookies a connection has picked up. Every request builds its
// own client, so without a jar a Set-Cookie would die with the response that
// carried it, and an API behind a login could only be used by pasting the
// session cookie into a header by hand.
//
// Cookies outlive a disconnect the way browser cookies outlive a tab: only
// clearing them or stopping the sidecar drops them.
//
// The stdlib jar runs without a public suffix list, which is deliberate for a
// debugging client: a cookie the server actually set is one the user means to
// send back, whatever its domain.
type Jar struct {
	mu  sync.RWMutex
	jar http.CookieJar
}

func NewJar() *Jar {
	jar, _ := cookiejar.New(nil)
	return &Jar{jar: jar}
}

func (j *Jar) Cookies(u *url.URL) []*http.Cookie {
	j.mu.RLock()
	defer j.mu.RUnlock()
	return j.jar.Cookies(u)
}

func (j *Jar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	j.mu.RLock()
	defer j.mu.RUnlock()
	j.jar.SetCookies(u, cookies)
}

// Clear drops everything the connection had collected so far.
func (j *Jar) Clear() {
	jar, _ := cookiejar.New(nil)
	j.mu.Lock()
	j.jar = jar
	j.mu.Unlock()
}
