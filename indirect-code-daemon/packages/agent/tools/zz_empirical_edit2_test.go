package tools

import (
	"strings"
	"testing"
)

// Round 2 of edit-engine probes (audit findings, not fixes).

// H2b: one fuzzy edit forces the WHOLE touched line to be rewritten from
// fuzzy-normalized bytes — characters outside the matched span (smart
// quotes, en-dashes, NBSP, trailing spaces) are silently rewritten.
func TestEmpiricalFuzzyRewritesWholeTouchedLine(t *testing.T) {
	content := "start ‘q’ fuzzy–target end ‘r’  \n"
	edits := []textEdit{{OldText: "fuzzy-target", NewText: "X"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H2b result: err=%v new=%q", err, newContent)
	if err == nil && newContent != "start ‘q’ X end ‘r’  \n" {
		t.Logf("H2b FINDING: untouched characters on the touched line were rewritten")
	}
}

// H2c: multi-edit — an exact edit's line is rewritten from normalized bytes
// because ANOTHER edit in the same call needed fuzzy matching.
func TestEmpiricalFuzzyGlobalCorruption(t *testing.T) {
	content := "keep ‘smart’ and – dash here\nfuzzy–target\n"
	edits := []textEdit{
		{OldText: "fuzzy-target", NewText: "X"},
		{OldText: "keep ‘smart’ and – dash here", NewText: "keep ‘smart’ and – dash here "},
	}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H2c result: err=%v new=%q", err, newContent)
}

// H10: whitespace-only old_text NOT present in the file degenerates to an
// empty pattern in fuzzy space -> zero-length match at offset 0, silently
// prepending new_text to the file.
func TestEmpiricalWhitespaceOnlyOldTextZeroLengthMatch(t *testing.T) {
	content := "abc\ndef\n"
	edits := []textEdit{{OldText: "  ", NewText: "X"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H10 result: err=%v new=%q", err, newContent)
	if err == nil && strings.HasPrefix(newContent, "X") {
		t.Logf("H10 FINDING: zero-length fuzzy match prepended new_text at offset 0")
	}
}

// H11: NBSP in an earlier line changes normalized line byte lengths, so the
// fuzzy-space index maps back onto the wrong original bytes.
func TestEmpiricalFuzzyIndexMisalignment(t *testing.T) {
	// Line 1 contains a NBSP (2 bytes in UTF-8 -> 1 byte after normalize).
	content := "a\u00A0b\ntarget_line\n"
	edits := []textEdit{{OldText: "target line", NewText: "X"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H11 result: err=%v new=%q", err, newContent)
}

// H12: duplicate counting in fuzzy space vs match index in exact space —
// unique exact text refused because a fuzzy twin exists (documented as
// H3); check the error message claims an occurrence count the model
// cannot reconcile with the file.
func TestEmpiricalDuplicateMessageMismatch(t *testing.T) {
	content := "alpha-beta\nalpha—beta\n"
	edits := []textEdit{{OldText: "alpha-beta", NewText: "gamma"}}
	_, _, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H12 result: err=%v (exact occurrences of old_text in file: %d)", err, strings.Count(content, "alpha-beta"))
}

// H13: indent-tolerant fallback fires on a SUBSTRING-style block even when
// an exact unique match exists later? (exact stage runs first — verify.)
func TestEmpiricalExactBeatsIndent(t *testing.T) {
	content := "  return 1\nreturn 1\n"
	edits := []textEdit{{OldText: "return 1", NewText: "return 2"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H13 result: err=%v new=%q", err, newContent)
}

// H14: transferIndent with a new_text that is empty (deletion) — line
// structure.
func TestEmpiricalIndentTransferDeletion(t *testing.T) {
	content := "func f() {\n\t\treturn 1\n\t\treturn 2\n}\n"
	edits := []textEdit{{OldText: "  return 1", NewText: ""}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H14 result: err=%v new=%q", err, newContent)
}

// H15: old_text == new_text for one edit while another changes — no-change
// guard is global.
func TestEmpiricalNoChangeGuardGlobal(t *testing.T) {
	content := "aaa\nbbb\n"
	edits := []textEdit{
		{OldText: "aaa", NewText: "aaa"},
		{OldText: "bbb", NewText: "ccc"},
	}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H15 result: err=%v new=%q", err, newContent)
}
