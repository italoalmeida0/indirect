package tools

import (
	"testing"
)

// H11 proper: force fuzzy matching (old_text has chars that normalize) while
// an EARLIER line contains a NBSP (2 UTF-8 bytes -> 1 in fuzzy space), so the
// fuzzy-space index maps back onto the wrong original byte offset.
func TestEmpiricalH11Proper(t *testing.T) {
	// Target line contains a smart quote so the match is fuzzy-only.
	// old_text uses the ASCII apostrophe form.
	content := "a\u00A0b\ntarget ‘x’ line\n"
	_, out, err := applyEditsToNormalizedContent(content, []textEdit{{OldText: "target 'x' line", NewText: "X"}}, "f.txt")
	t.Logf("H11c (NBSP prev line + fuzzy target): err=%v out=%q", err, out)

	// Control: same without the NBSP line.
	content2 := "ab\ntarget ‘x’ line\n"
	_, out2, err2 := applyEditsToNormalizedContent(content2, []textEdit{{OldText: "target 'x' line", NewText: "X"}}, "f.txt")
	t.Logf("H11c-control (no NBSP): err=%v out=%q", err2, out2)

	// Same-line NBSP + fuzzy target.
	content3 := "x\u00A0target ‘x’ line\n"
	_, out3, err3 := applyEditsToNormalizedContent(content3, []textEdit{{OldText: "target 'x' line", NewText: "X"}}, "f.txt")
	t.Logf("H11d (NBSP same line): err=%v out=%q", err3, out3)

	// Trailing-space line before + fuzzy target.
	content4 := "trail   \ntarget ‘x’ line\n"
	_, out4, err4 := applyEditsToNormalizedContent(content4, []textEdit{{OldText: "target 'x' line", NewText: "X"}}, "f.txt")
	t.Logf("H11e (trailing-space prev line): err=%v out=%q", err4, out4)

	// Emoji before + fuzzy target.
	content5 := "😀\ntarget ‘x’ line\n"
	_, out5, err5 := applyEditsToNormalizedContent(content5, []textEdit{{OldText: "target 'x' line", NewText: "X"}}, "f.txt")
	t.Logf("H11f (emoji prev line): err=%v out=%q", err5, out5)
}
