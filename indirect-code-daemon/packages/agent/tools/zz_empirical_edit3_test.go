package tools

import (
	"testing"
)

// H11 follow-up: nail the exact replacement-length bug when an earlier line
// contains a NBSP (2 UTF-8 bytes collapsing to 1 in fuzzy space).
func TestEmpiricalH11Mechanism(t *testing.T) {
	// Case A: NBSP on a PREVIOUS line.
	contentA := "a\u00A0b\ntarget_line\n"
	_, outA, errA := applyEditsToNormalizedContent(contentA, []textEdit{{OldText: "target line", NewText: "X"}}, "f.txt")
	t.Logf("A: err=%v out=%q", errA, outA)

	// Case B: same file, exact old_text (no fuzzy) — control.
	_, outB, errB := applyEditsToNormalizedContent(contentA, []textEdit{{OldText: "target_line", NewText: "X"}}, "f.txt")
	t.Logf("B (exact): err=%v out=%q", errB, outB)

	// Case C: NBSP on the SAME line as the target.
	contentC := "x\u00A0target_line\n"
	_, outC, errC := applyEditsToNormalizedContent(contentC, []textEdit{{OldText: "target line", NewText: "X"}}, "f.txt")
	t.Logf("C (same line): err=%v out=%q", errC, outC)

	// Case D: NBSP on a FOLLOWING line (target first).
	contentD := "target_line\na\u00A0b\n"
	_, outD, errD := applyEditsToNormalizedContent(contentD, []textEdit{{OldText: "target line", NewText: "X"}}, "f.txt")
	t.Logf("D (following line): err=%v out=%q", errD, outD)

	// Case E: two NBSP lines before the target.
	contentE := "a\u00A0b\nc\u00A0d\ntarget_line\n"
	_, outE, errE := applyEditsToNormalizedContent(contentE, []textEdit{{OldText: "target line", NewText: "X"}}, "f.txt")
	t.Logf("E (two NBSP lines): err=%v out=%q", errE, outE)

	// Case F: smart quote on a previous line (1 rune -> 1 byte after normalize).
	contentF := "a‘b\ntarget_line\n"
	_, outF, errF := applyEditsToNormalizedContent(contentF, []textEdit{{OldText: "target line", NewText: "X"}}, "f.txt")
	t.Logf("F (smart quote prev line): err=%v out=%q", errF, outF)

	// Case G: multi-byte rune (emoji) on a previous line.
	contentG := "😀\ntarget_line\n"
	_, outG, errG := applyEditsToNormalizedContent(contentG, []textEdit{{OldText: "target line", NewText: "X"}}, "f.txt")
	t.Logf("G (emoji prev line): err=%v out=%q", errG, outG)
}

// H15 follow-up: one no-op edit (old==new) aborts the whole batch even when
// other edits change content.
func TestEmpiricalH15Mechanism(t *testing.T) {
	content := "aaa\nbbb\n"
	edits := []textEdit{
		{OldText: "aaa", NewText: "aaa"},
		{OldText: "bbb", NewText: "ccc"},
	}
	_, out, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("batch with one no-op edit: err=%v out=%q", err, out)

	// Reverse order.
	edits2 := []textEdit{
		{OldText: "bbb", NewText: "ccc"},
		{OldText: "aaa", NewText: "aaa"},
	}
	_, out2, err2 := applyEditsToNormalizedContent(content, edits2, "f.txt")
	t.Logf("reversed order: err=%v out=%q", err2, out2)
}
