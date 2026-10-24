package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func repeaterTestSend(t *testing.T, s *Server, payload any) (int, repeaterSendResponse, string) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/repeater/send", bytes.NewReader(raw))
	w := httptest.NewRecorder()
	s.sendRepeater(w, r)
	var out repeaterSendResponse
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out, w.Body.String()
}

func TestRepeaterRejectsInvalidInput(t *testing.T) {
	t.Setenv(repeaterAllowLocalEnv, "")
	s := &Server{}
	for _, tc := range []struct {
		name string
		body string
	}{
		{"missing url", `{"method":"GET"}`},
		{"empty method", `{"method":"  ","url":"https://example.test/"}`},
		{"bad scheme", `{"method":"GET","url":"file:///etc/passwd"}`},
		{"gopher", `{"method":"GET","url":"gopher://example.test/1"}`},
		{"unknown method", `{"method":"TRACE","url":"http://example.test/"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/repeater/send", strings.NewReader(tc.body))
			w := httptest.NewRecorder()
			s.sendRepeater(w, r)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status=%d want 400 body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestRepeaterBlockedIPs(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "::1", "169.254.169.254", "0.0.0.0", "224.0.0.1"} {
		if !repeaterIsBlockedDialIP(net.ParseIP(raw)) {
			t.Errorf("expected %s blocked", raw)
		}
	}
	for _, raw := range []string{"8.8.8.8", "10.0.0.1", "192.168.1.20", "172.16.0.5"} {
		if repeaterIsBlockedDialIP(net.ParseIP(raw)) {
			t.Errorf("expected %s allowed", raw)
		}
	}

	t.Setenv(repeaterAllowLocalEnv, "")
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("loopback handler should not be reached")
	}))
	defer srv.Close()
	code, _, body := repeaterTestSend(t, &Server{}, map[string]any{"url": srv.URL, "use_recording_proxy": false})
	if code != http.StatusBadRequest || !strings.Contains(body, "拒绝") {
		t.Fatalf("loopback status=%d body=%s", code, body)
	}
}

func TestRepeaterRoundTripHeadersAndBody(t *testing.T) {
	t.Setenv(repeaterAllowLocalEnv, "1")
	var got http.Request
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = *r
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("X-Echo", "ok")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, "hello")
	}))
	defer srv.Close()

	code, out, body := repeaterTestSend(t, &Server{}, map[string]any{
		"method": "POST", "url": srv.URL, "headers": map[string]string{
			"X-Test": "yes", "Host": "custom.example", "Connection": "keep-alive",
			"Keep-Alive": "timeout=5", "Transfer-Encoding": "chunked", "Content-Length": "99",
		}, "body": "payload", "use_recording_proxy": false,
	})
	if code != http.StatusOK || out.Error != "" {
		t.Fatalf("status=%d out=%+v raw=%s", code, out, body)
	}
	if out.Status != http.StatusCreated || out.Body != "hello" || out.BodyBytes != 5 {
		t.Fatalf("response=%+v", out)
	}
	if out.Headers["X-Echo"][0] != "ok" || got.Method != http.MethodPost || gotBody != "payload" || got.Host != "custom.example" {
		t.Fatalf("request method=%s host=%s body=%q headers=%v", got.Method, got.Host, gotBody, got.Header)
	}
	for _, name := range []string{"Connection", "Keep-Alive", "Transfer-Encoding"} {
		if got.Header.Get(name) != "" {
			t.Errorf("hop-by-hop header %s was forwarded: %q", name, got.Header.Get(name))
		}
	}
	if got.Header.Get("Content-Length") != "7" {
		t.Errorf("content length should match body, got %q", got.Header.Get("Content-Length"))
	}
}

func TestRepeaterTruncatesAndHonoursHEAD(t *testing.T) {
	t.Setenv(repeaterAllowLocalEnv, "1")
	large := strings.Repeat("x", repeaterMaxBody+1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			_, _ = io.WriteString(w, "should-not-be-read")
			return
		}
		_, _ = io.WriteString(w, large)
	}))
	defer srv.Close()
	_, out, _ := repeaterTestSend(t, &Server{}, map[string]any{"url": srv.URL, "use_recording_proxy": false})
	if !out.BodyTruncated || out.BodyBytes != repeaterMaxBody || len(out.Body) != repeaterMaxBody {
		t.Fatalf("truncation=%+v", out)
	}
	_, head, _ := repeaterTestSend(t, &Server{}, map[string]any{"method": "HEAD", "url": srv.URL, "use_recording_proxy": false})
	if head.Body != "" || head.BodyBytes != 0 {
		t.Fatalf("HEAD body=%q bytes=%d", head.Body, head.BodyBytes)
	}
}

func TestRepeaterBodyTextReplacesBinaryControls(t *testing.T) {
	if got := repeaterBodyText([]byte{'a', 0, 0xff, 'b'}); got != "a��b" {
		t.Fatalf("body text=%q", got)
	}
}

func TestRepeaterRejectsCrossHostRedirect(t *testing.T) {
	t.Setenv(repeaterAllowLocalEnv, "1")
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "target") }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer redirect.Close()
	_, out, _ := repeaterTestSend(t, &Server{}, map[string]any{"url": redirect.URL, "use_recording_proxy": false})
	if out.Status != 0 || !strings.Contains(out.Error, "跨主机") {
		t.Fatalf("redirect response=%+v", out)
	}
}

func TestRepeaterSocks5TransportConstruction(t *testing.T) {
	s := &Server{m: &Manager{}}
	for _, scheme := range []string{"socks5", "socks5h"} {
		tr := s.httpProxyTransport(httpExec{Proxy: scheme + "://user:pass@127.0.0.1:1080"})
		if tr == nil || tr.Proxy == nil {
			t.Fatalf("%s transport not configured as SOCKS: %#v", scheme, tr)
		}
		proxyURL, err := tr.Proxy(httptest.NewRequest(http.MethodGet, "https://target.example/", nil))
		if err != nil || proxyURL == nil || proxyURL.Scheme != scheme || proxyURL.Host != "127.0.0.1:1080" {
			t.Fatalf("%s proxy URL = %#v, err=%v", scheme, proxyURL, err)
		}
		if user := proxyURL.User; user == nil || user.Username() != "user" {
			t.Fatalf("%s proxy credentials missing: %v", scheme, proxyURL.User)
		}
		password, ok := proxyURL.User.Password()
		if !ok || password != "pass" {
			t.Fatalf("%s proxy password missing: %q (ok=%v)", scheme, password, ok)
		}
	}

	// With capture disabled, the recording-proxy option must preserve the
	// configured global proxy URL instead of treating it as a host:port.
	s.m.globalProxy = "socks5://user:pass@127.0.0.1:1080"
	tr := s.httpProxyTransport(httpExec{UseRecordingProxy: true})
	if tr == nil || tr.Proxy == nil {
		t.Fatal("global SOCKS5 proxy was not configured")
	}
	proxyURL, err := tr.Proxy(httptest.NewRequest(http.MethodGet, "https://target.example/", nil))
	if err != nil || proxyURL == nil || proxyURL.Scheme != "socks5" {
		t.Fatalf("global proxy URL = %#v, err=%v", proxyURL, err)
	}
}
