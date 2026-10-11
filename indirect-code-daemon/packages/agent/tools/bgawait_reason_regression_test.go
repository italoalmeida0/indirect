package tools

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// Regression (audit bug 23): reason[:100] cut bytes and split a multibyte
// rune, shipping invalid UTF-8 in the UI summary (the reason lands in the
// tool result's summary attr). The cut must be rune-aware (like the
// daemon's noticePreview).
func TestBgAwaitReasonCutIsRuneSafe(t *testing.T) {
	// 60 x 3-byte runes = 180 bytes: the 100-byte cut lands mid-rune.
	reason := strings.Repeat("世界", 60)
	tool := &BgAwaitTool{Host: pinHost{status: "done", label: "cmd"}, SessionID: "s"}
	res, _ := awaitResult(t, tool, `{"max_wait_seconds":1,"waiting_for":"bg_1","reason":"`+reason+`"}`)
	var summary string
	for _, a := range res.Attrs {
		if a.Key == "summary" {
			summary = a.Value
		}
	}
	if summary == "" {
		t.Fatalf("no summary attr in result: %+v", res.Attrs)
	}
	if !utf8.ValidString(summary) {
		t.Fatalf("reason byte-cut split a multibyte rune: tail=%q", summary[len(summary)-8:])
	}
}
