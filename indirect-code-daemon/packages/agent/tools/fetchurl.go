package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"

	"golang.org/x/net/html"
)

type FetchURLArgs struct {
	// URL to fetch (required, http/https only).
	URL string `json:"url"`
	// MaxChars caps extracted text (default 12000, max 50000).
	MaxChars int `json:"max_chars,omitempty"`
	// TimeoutSec caps the request (default 20, max 60).
	TimeoutSec int `json:"timeout_sec,omitempty"`
}

// FetchURLTool downloads a page and extracts readable text. HTML
// via Readability-simplified extraction (x/net/html), text/code via
// content-type, PDFs and media refused with a clear message.
type FetchURLTool struct {
	CWD     string
	Sandbox *Sandbox
	// Client is swappable in tests.
	Client *http.Client
	// TestAllowLoopback disables the loopback/private guard for httptest
	// servers (127.0.0.1). Never set outside tests — production always
	// guards, including redirect hops.
	TestAllowLoopback bool
	// BrainDir is the optional per-session scratch directory. When set,
	// foreground synchronous outputs exceeding 20KB spill losslessly to
	// <BrainDir>/tool-<callID>.log while returning a compact inline preview.
	BrainDir string
	// ControlPort is the optional runner loopback IPC port that must never be dialed.
	ControlPort int
}

func (t *FetchURLTool) Name() string { return "fetch_url" }

func (t *FetchURLTool) Description() string {
	return "Fetch a URL and extract readable text. Params: `url` (required, http/https only — private IPs and file:// blocked), `max_chars` (default 12000, max 50000), `timeout_sec` (default 20, max 60). HTML articles extract main content; plain text/code returned raw; PDFs/media refused. Follows up to 5 redirects."
}

const fetchURLSchema = `{"type":"object","required":["url"],"properties":{"url":{"type":"string","description":"URL to fetch (http/https only)."},"max_chars":{"type":"number","description":"Max extracted chars (default 12000, max 50000)."},"timeout_sec":{"type":"number","description":"Request timeout in seconds (default 20, max 60)."}}}`

func (t *FetchURLTool) Schema() json.RawMessage { return json.RawMessage(fetchURLSchema) }

func (t *FetchURLTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a FetchURLArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	rawURL := strings.TrimSpace(a.URL)
	if rawURL == "" {
		return core.ToolResult{}, fmt.Errorf("fetch_url: `url` is required")
	}
	maxChars := a.MaxChars
	if maxChars <= 0 {
		maxChars = 12000
	}
	if maxChars > 50000 {
		maxChars = 50000
	}
	timeout := a.TimeoutSec
	if timeout <= 0 {
		timeout = 20
	}
	if timeout > 60 {
		timeout = 60
	}
	text, finalURL, truncated, err := t.fetch(ctx, rawURL, timeout)
	if err != nil {
		return core.ToolResult{}, err
	}
	fullText := text
	totalChars := len(fullText)
	if strings.TrimSpace(t.BrainDir) != "" && (a.MaxChars <= 0 || a.MaxChars > ArrivalSpillThresholdBytes) && len(fullText) > ArrivalSpillThresholdBytes {
		if spillRes, ok := maybeSpillOutput(ctx, t.BrainDir, fullText); ok {
			det := fetchDetail(finalURL, fullText, true)
			det["output"] = det["content"]
			det["full_output_path"] = spillRes.Path
			det["spill_path"] = spillRes.Path
			return core.ToolResult{
				Content: []provider.Content{provider.TextBlock{Text: spillRes.Preview}},
				Attrs: applySpillAttrs([]core.Attr{
					{Key: "url", Value: finalURL},
					{Key: "chars", Value: fmt.Sprintf("%d", totalChars)},
					{Key: "truncated", Value: "true"},
				}, spillRes),
				Details: det,
			}, nil
		}
	}
	if len(text) > maxChars {
		text = text[:maxChars]
		truncated = true
	}
	var attrs []core.Attr
	attrs = append(attrs,
		core.Attr{Key: "url", Value: finalURL},
		core.Attr{Key: "chars", Value: fmt.Sprintf("%d", totalChars)},
	)
	if truncated {
		attrs = append(attrs, core.Attr{Key: "truncated", Value: "true"})
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: text}},
		Attrs:   attrs,
		Details: fetchDetail(finalURL, text, truncated),
	}, nil
}

func (t *FetchURLTool) fetch(ctx context.Context, rawURL string, timeoutSec int) (string, string, bool, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return "", "", false, fmt.Errorf("fetch_url: invalid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", "", false, fmt.Errorf("fetch_url: only http/https allowed (got %q)", u.Scheme)
	}
	if err := t.guardURL(u); err != nil {
		return "", "", false, err
	}

	client := t.Client
	if client == nil {
		client = &http.Client{
			Timeout:   time.Duration(timeoutSec) * time.Second,
			Transport: t.newPinnedTransport(timeoutSec),
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 5 {
					return fmt.Errorf("fetch_url: too many redirects")
				}
				// Re-guard every hop: a public URL may redirect to metadata/private IP.
				if err := t.guardURL(req.URL); err != nil {
					return err
				}
				return nil
			},
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", "", false, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1")
	resp, err := client.Do(req)
	if err != nil {
		return "", "", false, fmt.Errorf("fetch_url: request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", false, fmt.Errorf("fetch_url: HTTP %d", resp.StatusCode)
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	body, err := io.ReadAll(io.LimitReader(resp.Body, 5*1024*1024))
	if err != nil {
		return "", "", false, fmt.Errorf("fetch_url: read failed: %v", err)
	}
	finalURL := resp.Request.URL.String()

	switch {
	case strings.Contains(ct, "pdf"):
		return "", finalURL, false, fmt.Errorf("fetch_url: PDFs not supported (content-type %s)", mimeOf(ct))
	case strings.HasPrefix(ct, "image/") || strings.HasPrefix(ct, "video/") || strings.HasPrefix(ct, "audio/"):
		return "", finalURL, false, fmt.Errorf("fetch_url: media not supported (content-type %s)", mimeOf(ct))
	case strings.Contains(ct, "html") || strings.Contains(ct, "xml") || ct == "" && looksLikeHTML(body):
		text := extractArticle(bytes.NewReader(body))
		if strings.TrimSpace(text) == "" {
			return "", finalURL, false, fmt.Errorf("fetch_url: no readable content found")
		}
		return text, finalURL, false, nil
	default:
		// Plain text, JSON, code, markdown...: return raw (validated UTF-8-ish).
		if !isText(body) {
			return "", finalURL, false, fmt.Errorf("fetch_url: binary content not supported (content-type %s)", mimeOf(ct))
		}
		return strings.TrimSpace(string(body)), finalURL, false, nil
	}
}

func mimeOf(ct string) string {
	if i := strings.Index(ct, ";"); i >= 0 {
		return strings.TrimSpace(ct[:i])
	}
	return strings.TrimSpace(ct)
}

func looksLikeHTML(body []byte) bool {
	s := strings.TrimSpace(string(body[:min(512, len(body))]))
	s = strings.ToLower(s)
	return strings.HasPrefix(s, "<!doctype html") || strings.HasPrefix(s, "<html")
}

// guardURL validates both host and port against SSRF, metadata, and runner control-port rules.
func (t *FetchURLTool) guardURL(u *url.URL) error {
	if u == nil {
		return fmt.Errorf("fetch_url: invalid URL")
	}
	host := u.Hostname()
	if t.ControlPort > 0 {
		pNum := 0
		if pStr := u.Port(); pStr != "" {
			pNum, _ = strconv.Atoi(pStr)
		} else if u.Scheme == "http" {
			pNum = 80
		} else if u.Scheme == "https" {
			pNum = 443
		}
		if pNum == t.ControlPort && isLoopbackOrUnspecifiedHost(host) {
			return fmt.Errorf("fetch_url: runner control port blocked")
		}
	}
	return t.guard(host)
}

// guard applies the SSRF and interactive permission policy.
func (t *FetchURLTool) guard(host string) error {
	if isCloudMetadataHost(host) {
		return fmt.Errorf("fetch_url: cloud metadata blocked")
	}
	if t.Sandbox != nil {
		if err := t.Sandbox.CheckNetHost(host); err != nil {
			return err
		}
		if mode, ok := t.Sandbox.InteractiveAccessMode(); ok {
			if eff, r := MatchRules(t.Sandbox.EffectiveRules(), "net", host, t.Sandbox.Root); eff == "deny" {
				return fmt.Errorf("permission denied: network host %q blocked by rule %q", host, r.Pattern)
			}
			if mode == "full" {
				return nil
			}
			if isLoopbackHost(host) {
				return nil
			}
			return guardSSRF(host)
		}
	}
	if t.TestAllowLoopback && isLoopbackHost(host) {
		return nil
	}
	return guardSSRF(host)
}

func (t *FetchURLTool) newPinnedTransport(timeoutSec int) *http.Transport {
	var tr *http.Transport
	if base, ok := http.DefaultTransport.(*http.Transport); ok && base != nil {
		tr = base.Clone()
	} else {
		tr = &http.Transport{}
	}
	dialer := &net.Dialer{
		Timeout:   time.Duration(timeoutSec) * time.Second,
		KeepAlive: 30 * time.Second,
	}
	tr.DialContext = func(dialCtx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		if isCloudMetadataHost(host) {
			return nil, fmt.Errorf("fetch_url: cloud metadata blocked")
		}
		pNum, _ := strconv.Atoi(port)
		if t.ControlPort > 0 && pNum == t.ControlPort && isLoopbackOrUnspecifiedHost(host) {
			return nil, fmt.Errorf("fetch_url: runner control port blocked")
		}
		mode, interactive := "", false
		if t.Sandbox != nil {
			mode, interactive = t.Sandbox.InteractiveAccessMode()
		}
		allowPrivate := interactive && mode == "full"
		allowLoopback := allowPrivate || (interactive && isLoopbackHost(host)) || (t.TestAllowLoopback && isLoopbackHost(host))

		var candidates []netip.Addr
		if parsed, ok := parseNormalizedAddr(host); ok {
			candidates = []netip.Addr{parsed}
		} else {
			norm := normalizeHostForSSRF(host)
			if !allowPrivate && strings.HasSuffix(norm, ".localhost") {
				return nil, fmt.Errorf("fetch_url: localhost subdomain blocked")
			}
			resolved, rerr := net.DefaultResolver.LookupNetIP(dialCtx, "ip", host)
			if rerr != nil {
				return nil, rerr
			}
			if len(resolved) == 0 {
				return nil, fmt.Errorf("fetch_url: host %q resolved to no addresses", host)
			}
			for _, r := range resolved {
				candidates = append(candidates, r.WithZone("").Unmap())
			}
		}

		var dialable []netip.Addr
		for _, ip := range candidates {
			if isCloudMetadataAddr(ip) {
				return nil, fmt.Errorf("fetch_url: cloud metadata IP blocked (%s)", ip)
			}
			if t.ControlPort > 0 && pNum == t.ControlPort && (ip.IsLoopback() || ip.IsUnspecified()) {
				return nil, fmt.Errorf("fetch_url: runner control port blocked")
			}
			if !allowPrivate {
				if ip.IsLoopback() {
					if !allowLoopback {
						return nil, fmt.Errorf("fetch_url: loopback IP blocked (%s)", ip)
					}
				} else if isPrivateOrReservedAddr(ip) {
					return nil, fmt.Errorf("fetch_url: private IP blocked (%s)", ip)
				}
			}
			dialable = append(dialable, ip)
		}

		var lastErr error
		for _, ip := range dialable {
			target := net.JoinHostPort(ip.String(), port)
			conn, derr := dialer.DialContext(dialCtx, network, target)
			if derr == nil {
				return conn, nil
			}
			lastErr = derr
		}
		if lastErr != nil {
			return nil, lastErr
		}
		return nil, fmt.Errorf("fetch_url: no valid address for %q", host)
	}
	return tr
}

func normalizeHostForSSRF(host string) string {
	h := strings.ToLower(strings.TrimSpace(host))
	h = strings.Trim(h, "[]")
	h = strings.TrimRight(h, ".")
	return h
}

func parseNormalizedAddr(host string) (netip.Addr, bool) {
	h := strings.TrimSpace(host)
	h = strings.Trim(h, "[]")
	if h == "" {
		return netip.Addr{}, false
	}
	if addr, err := netip.ParseAddr(h); err == nil {
		return addr.WithZone("").Unmap(), true
	}
	if ip := net.ParseIP(h); ip != nil {
		if addr, ok := netip.AddrFromSlice(ip); ok {
			return addr.WithZone("").Unmap(), true
		}
	}
	return netip.Addr{}, false
}

var (
	metadataIPv4AWS     = netip.MustParseAddr("169.254.169.254")
	metadataIPv6AWS     = netip.MustParseAddr("fd00:ec2::254")
	metadataIPv4Alibaba = netip.MustParseAddr("100.100.100.200")
)

func isCloudMetadataAddr(addr netip.Addr) bool {
	u := addr.WithZone("").Unmap()
	if !u.IsValid() {
		return false
	}
	return u == metadataIPv4AWS || u == metadataIPv6AWS || u == metadataIPv4Alibaba
}

func isCloudMetadataHost(host string) bool {
	if addr, ok := parseNormalizedAddr(host); ok {
		return isCloudMetadataAddr(addr)
	}
	h := normalizeHostForSSRF(host)
	switch h {
	case "metadata.google.internal", "metadata", "instance-data":
		return true
	}
	return strings.HasSuffix(h, ".metadata.google.internal")
}

func isLoopbackHost(host string) bool {
	if addr, ok := parseNormalizedAddr(host); ok {
		return addr.IsLoopback()
	}
	h := strings.ToLower(strings.TrimSpace(host))
	return h == "localhost" || h == "localhost."
}

func isLoopbackOrUnspecifiedHost(host string) bool {
	if isLoopbackHost(host) {
		return true
	}
	if addr, ok := parseNormalizedAddr(host); ok && addr.IsUnspecified() {
		return true
	}
	return false
}

func isPrivateOrReservedAddr(addr netip.Addr) bool {
	u := addr.WithZone("").Unmap()
	if !u.IsValid() {
		return true
	}
	if isCloudMetadataAddr(u) {
		return true
	}
	if u.IsLoopback() || u.IsPrivate() || u.IsLinkLocalUnicast() || u.IsLinkLocalMulticast() || u.IsMulticast() || u.IsUnspecified() {
		return true
	}
	if u.Is4() {
		b := u.As4()
		switch {
		case b[0] == 0:
			return true
		case b[0] == 100 && b[1] >= 64 && b[1] <= 127:
			return true
		case b[0] == 198 && (b[1] == 18 || b[1] == 19):
			return true
		case b[0] >= 240:
			return true
		}
	}
	return false
}

// guardSSRF blocks private/loopback/link-local/metadata targets: private ranges,
// cloud metadata IPs and localhost names — plus file:// never reaches here (scheme check).
func guardSSRF(host string) error {
	h := strings.ToLower(strings.TrimSpace(strings.Trim(host, "[]")))
	if h == "" {
		return fmt.Errorf("fetch_url: empty host")
	}
	norm := normalizeHostForSSRF(h)
	if norm == "localhost" || strings.HasSuffix(norm, ".localhost") {
		return fmt.Errorf("fetch_url: localhost blocked")
	}
	if isCloudMetadataHost(h) {
		return fmt.Errorf("fetch_url: cloud metadata blocked")
	}
	if addr, ok := parseNormalizedAddr(h); ok {
		if isPrivateOrReservedAddr(addr) {
			return fmt.Errorf("fetch_url: private IP blocked (%s)", addr)
		}
		return nil
	}
	ips, err := net.LookupIP(h)
	if err != nil || len(ips) == 0 {
		// Unresolvable: let the request fail naturally (no leak either way).
		// But literal IPs that fail to parse are suspicious — block.
		if ip := net.ParseIP(h); ip != nil {
			return fmt.Errorf("fetch_url: unresolvable IP blocked")
		}
		return nil
	}
	for _, ip := range ips {
		if isPrivateIP(ip) {
			return fmt.Errorf("fetch_url: private IP blocked (%s)", ip)
		}
	}
	return nil
}

func isPrivateIP(ip net.IP) bool {
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return true
	}
	return isPrivateOrReservedAddr(addr.Unmap())
}

// extractArticle is a Readability-simplified main-content extraction:
// strip noise tags, drop nav/footer/
// hidden subtrees, unwrap links (keeping hrefs), then pick the highest
// text-density block among article/main candidates (fallback: body).
func extractArticle(r io.Reader) string {
	doc, err := html.Parse(r)
	if err != nil {
		return ""
	}
	stripNoise(doc)
	best := pickMain(doc)
	if best == nil {
		best = doc
	}
	var b strings.Builder
	renderReadable(best, &b)
	text := strings.TrimSpace(b.String())
	// Collapse 3+ blank lines.
	for strings.Contains(text, "\n\n\n") {
		text = strings.ReplaceAll(text, "\n\n\n", "\n\n")
	}
	return text
}

var noiseTags = map[string]bool{
	"script": true, "style": true, "noscript": true, "template": true,
	"svg": true, "canvas": true, "iframe": true, "object": true, "embed": true,
	"form": true, "input": true, "button": true, "select": true, "textarea": true,
	"nav": true, "footer": true, "aside": true, "header": true,
}

func stripNoise(n *html.Node) {
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		if c.Type == html.ElementNode {
			if noiseTags[c.Data] {
				n.RemoveChild(c)
				c = next
				continue
			}
			if c.Data == "div" || c.Data == "section" {
				if cls := nodeClass(c); cls != "" && (strings.Contains(cls, "nav") || strings.Contains(cls, "footer") || strings.Contains(cls, "sidebar") || strings.Contains(cls, "cookie") || strings.Contains(cls, "popup")) {
					n.RemoveChild(c)
					c = next
					continue
				}
			}
			if isHidden(c) {
				n.RemoveChild(c)
				c = next
				continue
			}
		}
		if c.Type == html.CommentNode {
			n.RemoveChild(c)
			c = next
			continue
		}
		stripNoise(c)
		c = next
	}
}

func nodeClass(n *html.Node) string {
	for _, a := range n.Attr {
		if a.Key == "class" {
			return strings.ToLower(a.Val)
		}
	}
	return ""
}

func isHidden(n *html.Node) bool {
	for _, a := range n.Attr {
		if a.Key == "hidden" {
			return true
		}
		if a.Key == "style" {
			st := strings.ToLower(strings.ReplaceAll(a.Val, " ", ""))
			if strings.Contains(st, "display:none") || strings.Contains(st, "visibility:hidden") {
				return true
			}
		}
		if a.Key == "aria-hidden" && strings.ToLower(a.Val) == "true" {
			return true
		}
	}
	return false
}

// pickMain scores article/main/[role=main] candidates by text density
// (paragraph text minus link text); falls back to body.
func pickMain(doc *html.Node) *html.Node {
	var candidates []*html.Node
	var body *html.Node
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if n.Data == "body" && body == nil {
				body = n
			}
			if n.Data == "article" || n.Data == "main" {
				candidates = append(candidates, n)
			} else if n.Data == "div" {
				for _, a := range n.Attr {
					if a.Key == "role" && a.Val == "main" {
						candidates = append(candidates, n)
					}
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	best := body
	bestScore := -1
	for _, c := range candidates {
		if s := density(c); s > bestScore {
			bestScore = s
			best = c
		}
	}
	if bestScore <= 0 {
		return body
	}
	return best
}

func density(n *html.Node) int {
	text, links := 0, 0
	var walk func(x *html.Node, inLink bool)
	walk = func(x *html.Node, inLink bool) {
		if x.Type == html.TextNode {
			l := len(strings.Fields(x.Data))
			text += l
			if inLink {
				links += l
			}
		}
		if x.Type == html.ElementNode && x.Data == "a" {
			inLink = true
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			walk(c, inLink)
		}
	}
	walk(n, false)
	return text - links
}

// renderReadable emits markdown-ish text: headings get # prefixes,
// links keep [text](href), code/pre stay verbatim, li gets bullets.
func renderReadable(n *html.Node, b *strings.Builder) {
	switch n.Type {
	case html.TextNode:
		b.WriteString(n.Data)
		return
	case html.CommentNode:
		return
	}
	if n.Type != html.ElementNode {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			renderReadable(c, b)
		}
		return
	}
	switch n.Data {
	case "br":
		b.WriteString("\n")
		return
	case "hr":
		b.WriteString("\n---\n")
		return
	case "p", "div", "section", "article", "main", "blockquote", "tr", "dd", "dt":
		b.WriteString("\n")
		renderChildren(n, b)
		b.WriteString("\n")
	case "h1":
		b.WriteString("\n# ")
		renderChildren(n, b)
		b.WriteString("\n")
	case "h2":
		b.WriteString("\n## ")
		renderChildren(n, b)
		b.WriteString("\n")
	case "h3":
		b.WriteString("\n### ")
		renderChildren(n, b)
		b.WriteString("\n")
	case "h4", "h5", "h6":
		b.WriteString("\n#### ")
		renderChildren(n, b)
		b.WriteString("\n")
	case "li":
		b.WriteString("\n- ")
		renderChildren(n, b)
	case "ul", "ol":
		b.WriteString("\n")
		renderChildren(n, b)
		b.WriteString("\n")
	case "pre", "code":
		b.WriteString("\n```\n")
		b.WriteString(strings.Trim(textOf(n), "\n"))
		b.WriteString("\n```\n")
		return // children already consumed
	case "a":
		href := ""
		for _, a := range n.Attr {
			if a.Key == "href" {
				href = strings.TrimSpace(a.Val)
			}
		}
		label := strings.TrimSpace(textOf(n))
		if label == "" {
			return
		}
		if href != "" && !strings.HasPrefix(href, "#") {
			fmt.Fprintf(b, "[%s](%s)", label, href)
		} else {
			b.WriteString(label)
		}
		return
	case "img":
		alt := ""
		for _, a := range n.Attr {
			if a.Key == "alt" {
				alt = strings.TrimSpace(a.Val)
			}
		}
		if alt != "" {
			fmt.Fprintf(b, "[image: %s]", alt)
		}
		return
	default:
		renderChildren(n, b)
	}
}

func renderChildren(n *html.Node, b *strings.Builder) {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		renderReadable(c, b)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func fetchDetail(finalURL, text string, truncated bool) map[string]any {
	host := ""
	if u, err := url.Parse(finalURL); err == nil {
		host = u.Hostname()
	}
	title := articleTitle(text)
	capped, wasCapped := capToolDetailPreview(text, maxInlineToolDetailBytes)
	return map[string]any{"url": finalURL, "host": host, "title": title, "content": capped, "truncated": truncated || wasCapped}
}

func articleTitle(text string) string {
	for _, ln := range strings.Split(text, "\n") {
		ln = strings.TrimSpace(ln)
		if strings.HasPrefix(ln, "# ") {
			return strings.TrimSpace(strings.TrimPrefix(ln, "# "))
		}
	}
	return ""
}
