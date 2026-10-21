package main

import (
	"strings"

	"indirect/indirect-code-daemon/packages/provider"
)

// migrateLegacyWidgets converts pre-id generative_ui fences in a session's
// transcript to the current format. There is no legacy runtime path: the
// frontend parser only understands header fences with `id:`, so old shapes
// are rewritten at load time, once:
//
//   - fences with an `@jsx` body → a plain ```jsx code fence carrying just
//     the body (headers dropped: the code is visible as ordinary code).
//   - fences without an `@jsx` body (the oldest shape) → dropped entirely.
//   - fences with an `id:` header (the current format) → untouched.
//
// Returns true when anything changed (caller persists).
func migrateLegacyWidgets(rec *SessionRecord) bool {
	if rec == nil {
		return false
	}
	changed := false
	for i := range rec.Messages {
		for j, c := range rec.Messages[i].Content {
			tb, ok := c.(provider.TextBlock)
			if !ok {
				continue
			}
			out, did := migrateLegacyWidgetFences(tb.Text)
			if did {
				rec.Messages[i].Content[j] = provider.TextBlock{Text: out}
				changed = true
			}
		}
	}
	return changed
}

// migrateLegacyWidgetFences rewrites one text blob's legacy fences. The
// scanner is line-based: an opening ```generative_ui fence (3+ backticks)
// runs until a closing fence of at least as many backticks.
func migrateLegacyWidgetFences(text string) (string, bool) {
	if !strings.Contains(text, "generative_ui") {
		return text, false
	}
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	changed := false
	i := 0
	for i < len(lines) {
		ticks := openingWidgetFence(lines[i])
		if ticks == "" {
			out = append(out, lines[i])
			i++
			continue
		}
		// Collect the fence body until the closing fence.
		start := i
		i++
		var body []string
		closed := false
		for i < len(lines) {
			if closingFence(lines[i], ticks) {
				closed = true
				i++
				break
			}
			body = append(body, lines[i])
			i++
		}
		_ = start
		header, code, hasMarker := splitLegacyWidgetBody(body)
		if hasMarker {
			// Legacy @jsx body: re-emit as a plain jsx code fence.
			changed = true
			out = append(out, "```jsx")
			out = append(out, code...)
			if closed {
				out = append(out, "```")
			}
			continue
		}
		if hasIDHeader(header) {
			// Current format. Normalize a first-cut `id:` header to
			// `widget_id:` so every fence names the link the same way.
			block := lines[start:i]
			if hasBareIDHeader(header) {
				block = renameIDHeader(block)
				changed = true
			}
			out = append(out, block...)
			continue
		}
		// Oldest shape (no @jsx body, no id): drop the fence entirely.
		changed = true
		_ = code
	}
	return strings.Join(out, "\n"), changed
}

// openingWidgetFence returns the tick run of a ```generative_ui opening
// fence line (3+ backticks), or "" when the line is not one.
func openingWidgetFence(line string) string {
	trimmed := strings.TrimSpace(line)
	n := 0
	for n < len(trimmed) && trimmed[n] == '`' {
		n++
	}
	if n < 3 {
		return ""
	}
	if strings.TrimSpace(trimmed[n:]) != "generative_ui" {
		return ""
	}
	return trimmed[:n]
}

// closingFence reports whether the line closes a fence opened with `ticks`.
func closingFence(line, ticks string) bool {
	trimmed := strings.TrimSpace(line)
	if len(trimmed) < len(ticks) {
		return false
	}
	for i := 0; i < len(trimmed); i++ {
		if trimmed[i] != '`' {
			return strings.TrimSpace(trimmed[i:]) == "" && i >= len(ticks)
		}
	}
	return len(trimmed) >= len(ticks)
}

// splitLegacyWidgetBody separates the header lines from the module code.
// hasMarker reports whether the body carries the legacy `@jsx` marker (the
// code starts after it). Body content without any `@jsx` marker is the
// oldest shape and is dropped by the caller.
func splitLegacyWidgetBody(body []string) (header, code []string, hasMarker bool) {
	seenCode := false
	for _, line := range body {
		trimmed := strings.TrimSpace(line)
		if !hasMarker && !seenCode && strings.HasPrefix(trimmed, "@jsx") {
			hasMarker = true
			continue
		}
		if !hasMarker && !seenCode {
			low := strings.ToLower(trimmed)
			if trimmed == "" || strings.HasPrefix(low, "placeholder:") ||
				strings.HasPrefix(low, "state:") || strings.HasPrefix(low, "id:") ||
				strings.HasPrefix(low, "widget_id:") {
				header = append(header, line)
				continue
			}
			// Unrecognized content without any marker: the oldest shape.
			seenCode = true
			code = append(code, line)
			continue
		}
		code = append(code, line)
	}
	return header, code, hasMarker
}

// hasIDHeader reports whether the fence header block carries a widget link
// (`widget_id:`, or the first-cut `id:`) — the current format.
func hasIDHeader(header []string) bool {
	for _, line := range header {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		low := strings.ToLower(trimmed)
		if strings.HasPrefix(low, "widget_id:") || strings.HasPrefix(low, "id:") {
			return true
		}
	}
	return false
}

// hasBareIDHeader reports whether the header block uses the first-cut
// `id:` key (which renameIDHeader rewrites to `widget_id:`).
func hasBareIDHeader(header []string) bool {
	for _, line := range header {
		low := strings.ToLower(strings.TrimSpace(line))
		if strings.HasPrefix(low, "id:") {
			return true
		}
	}
	return false
}

// renameIDHeader rewrites the `id:` header key to `widget_id:` (the
// canonical fence link name), preserving indentation and value.
func renameIDHeader(block []string) []string {
	out := append([]string(nil), block...)
	for i, line := range out {
		low := strings.ToLower(strings.TrimSpace(line))
		if !strings.HasPrefix(low, "id:") {
			continue
		}
		indent := line[:len(line)-len(strings.TrimLeft(line, " \t"))]
		rest := strings.TrimSpace(line)[len("id:"):]
		out[i] = indent + "widget_id:" + rest
	}
	return out
}
