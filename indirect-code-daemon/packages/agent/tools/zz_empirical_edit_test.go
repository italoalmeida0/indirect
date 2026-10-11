package tools

import (
	"strings"
	"testing"
)

// Empirical probes for the edit engine (audit only — these document real
// behaviour; failures here are FINDINGS, not regressions to fix).

// H1: countOccurrences works in fuzzy-normalized space even when the match
// itself is exact. A unique exact old_text can be reported as a duplicate
// because normalization collapses distinct strings.
func TestEmpiricalFalseDuplicate(t *testing.T) {
	// Line 1 has trailing spaces; line 2 does not. "x  " is unique exactly.
	content := "x  \nx\n"
	edits := []textEdit{{OldText: "x  ", NewText: "y"}}
	_, _, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H1 trailing-space result: err=%v", err)
	if err == nil {
		t.Logf("H1: edit applied (no false duplicate)")
	} else {
		t.Logf("H1 FINDING?: edit rejected: %v", err)
	}
}

// H1b: smart quote variant — exact unique, fuzzy duplicate.
func TestEmpiricalFalseDuplicateSmartQuote(t *testing.T) {
	content := "foo‘\nfoo'\n"
	edits := []textEdit{{OldText: "foo‘", NewText: "bar"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H1b smart-quote result: err=%v new=%q", err, newContent)
}

// H2: when ANY edit needs fuzzy matching, ALL content runs through
// normalizeForFuzzyMatch and touched lines keep the NORMALIZED bytes —
// unrelated characters in touched lines (smart quotes, dashes, NBSP,
// trailing whitespace) are silently rewritten.
func TestEmpiricalFuzzyCorruptsTouchedLines(t *testing.T) {
	content := "a ‘quoted’ word — dash\nkeep this line\nfuzzy_target  \n"
	edits := []textEdit{{OldText: "fuzzy target", NewText: "fuzzy_replaced"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H2 result: err=%v\nnew=%q", err, newContent)
	if err == nil && strings.Contains(newContent, "‘quoted’") {
		t.Logf("H2: untouched chars preserved")
	} else if err == nil {
		t.Logf("H2 FINDING?: touched-line characters were rewritten: %q", newContent)
	}
}

// H3: exact match unique in exact space, but old_text also matches a second
// region only after normalization -> whole edit refused.
func TestEmpiricalFuzzyCountVsIndex(t *testing.T) {
	content := "alpha-beta\nalpha—beta\n"
	edits := []textEdit{{OldText: "alpha-beta", NewText: "gamma"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H3 result: err=%v new=%q", err, newContent)
}

// H4: indent-tolerant fallback with tabs/spaces mismatch.
func TestEmpiricalIndentTransfer(t *testing.T) {
	content := "func f() {\n\t\treturn 1\n}\n"
	edits := []textEdit{{OldText: "  return 1", NewText: "  return 2"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H4 result: err=%v new=%q", err, newContent)
}

// H5: CRLF file, edit without line endings in old_text.
func TestEmpiricalCRLF(t *testing.T) {
	content := "line1\r\nline2\r\n"
	edits := []textEdit{{OldText: "line2", NewText: "lineX"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H5 result: err=%v new=%q", err, newContent)
}

// H6: multiple edits where one is fuzzy — offsets in mixed space.
func TestEmpiricalMixedFuzzyExact(t *testing.T) {
	content := "one ‘two’ three\nfour_target\nfive\n"
	edits := []textEdit{
		{OldText: "four target", NewText: "four_replaced"},
		{OldText: "five", NewText: "5ive"},
	}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H6 result: err=%v new=%q", err, newContent)
}

// H7: old_text spanning a line with trailing whitespace, exact match.
func TestEmpiricalTrailingWSExact(t *testing.T) {
	content := "aaa   \nbbb\nccc\n"
	edits := []textEdit{{OldText: "aaa   \nbbb", NewText: "zzz"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H7 result: err=%v new=%q", err, newContent)
}

// H8: empty-ish old_text made only of whitespace.
func TestEmpiricalWhitespaceOnlyOldText(t *testing.T) {
	content := "a\n  \nb\n"
	edits := []textEdit{{OldText: "  ", NewText: ""}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H8 result: err=%v new=%q", err, newContent)
}

// H9: duplicate detection with overlapping occurrences (aaa in aaaa).
func TestEmpiricalOverlappingCount(t *testing.T) {
	content := "aaaa\n"
	edits := []textEdit{{OldText: "aa", NewText: "b"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	t.Logf("H9 result: err=%v new=%q", err, newContent)
}
