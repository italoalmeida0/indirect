package provider

import (
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"
)

var errStreamIdleTimeout = errors.New("stream idle timeout: no bytes received from upstream")

var (
	// ProviderResponseHeaderTimeout bounds how long an upstream LLM POST may
	// remain silent before returning response headers. Kept strictly below the
	// daemon's 10-minute provider declared-wait window so a half-open socket or
	// network handoff surfaces as a retryable HTTP error instead of tripping
	// watchdog_stale and cancelling an unattended multi-day turn.
	ProviderResponseHeaderTimeout = 5 * time.Minute

	// ProviderStreamIdleTimeout bounds how long an open SSE response body may go
	// with zero bytes read (even SSE `: keep-alive` comments reset it). Kept
	// strictly below tuneWaitProvider so mid-stream network blackholes recover
	// via automatic retry instead of stalling the turn.
	ProviderStreamIdleTimeout = 4 * time.Minute
)

// NewHTTPClient returns a provider HTTP client. When insecureTLS is true,
// only this client skips TLS certificate verification. The process-wide
// default transport is left untouched so auth, discovery, and other providers
// keep normal certificate validation.
func NewHTTPClient(insecureTLS bool) *http.Client {
	return NewHTTPClientWithProxy(insecureTLS, "")
}

// NewHTTPClientWithProxy is NewHTTPClient plus an explicit upstream proxy.
// An empty proxy keeps the default environment-based proxy resolution
// (HTTP(S)_PROXY). A malformed proxy URL falls back to the default behavior
// instead of failing the turn.
func NewHTTPClientWithProxy(insecureTLS bool, proxyURL string) *http.Client {
	tr, ok := http.DefaultTransport.(*http.Transport)
	if ok {
		tr = tr.Clone()
	} else {
		tr = &http.Transport{}
	}
	dialer := &net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 15 * time.Second,
	}
	tr.DialContext = dialer.DialContext
	tr.TLSHandshakeTimeout = 30 * time.Second
	if ProviderResponseHeaderTimeout > 0 {
		tr.ResponseHeaderTimeout = ProviderResponseHeaderTimeout
	}
	tr.IdleConnTimeout = 90 * time.Second
	if proxyURL != "" {
		if u, err := url.Parse(proxyURL); err == nil && u.Scheme != "" && u.Host != "" {
			tr.Proxy = http.ProxyURL(u)
		}
	}
	if !insecureTLS {
		return &http.Client{Timeout: 0, Transport: tr}
	}
	if tr.TLSClientConfig != nil {
		tr.TLSClientConfig = tr.TLSClientConfig.Clone()
	} else {
		tr.TLSClientConfig = &tls.Config{}
	}
	tr.TLSClientConfig.InsecureSkipVerify = true //nolint:gosec
	return &http.Client{Timeout: 0, Transport: tr}
}

// WithHTTPClient scopes an HTTP client to a concrete provider client.
// Unsupported clients are returned unchanged.
func WithHTTPClient(c Client, httpClient *http.Client) Client {
	if httpClient == nil {
		return c
	}
	if v, ok := c.(*anthropicClient); ok {
		v.http = httpClient
	}
	return c
}

type streamIdleReadCloser struct {
	inner   io.ReadCloser
	timeout time.Duration
	mu      sync.Mutex
	timer   *time.Timer
	timedOut bool
	closed  bool
}

func newStreamIdleReadCloser(rc io.ReadCloser, timeout time.Duration) io.ReadCloser {
	if rc == nil || timeout <= 0 {
		return rc
	}
	s := &streamIdleReadCloser{
		inner:   rc,
		timeout: timeout,
	}
	s.timer = time.AfterFunc(timeout, func() {
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return
		}
		s.timedOut = true
		s.mu.Unlock()
		_ = rc.Close()
	})
	return s
}

func (s *streamIdleReadCloser) Read(p []byte) (int, error) {
	n, err := s.inner.Read(p)
	s.mu.Lock()
	timedOut := s.timedOut
	if n > 0 && !s.closed && !timedOut && s.timer != nil {
		s.timer.Reset(s.timeout)
	}
	s.mu.Unlock()
	if timedOut && err != nil {
		return n, errStreamIdleTimeout
	}
	return n, err
}

func (s *streamIdleReadCloser) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	if s.timer != nil {
		s.timer.Stop()
	}
	s.mu.Unlock()
	return s.inner.Close()
}
