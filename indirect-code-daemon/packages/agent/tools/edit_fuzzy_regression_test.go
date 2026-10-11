package tools

import (
	"strings"
	"testing"
)

// Regression tests for the edit engine's fuzzy-match space handling.
// These were found empirically (see empirical-audit/findings.md F1-1..F1-3):
// fuzzy matches used to be applied in normalized space, rewriting whole
// touched lines; a whitespace-only old_text degenerated to a zero-length
// match at offset 0; and duplicate counting ran in fuzzy space while the
// match itself was exact.

// F1-1: a fuzzy-only match must rewrite ONLY the matched bytes — every
// other character on the touched line keeps its original form.
func TestEditFuzzyMatchPreservesUnmatchedBytes(t *testing.T) {
	content := "start ‘q’ fuzzy–target end ‘r’  \n"
	edits := []textEdit{{OldText: "fuzzy-target", NewText: "X"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	if err != nil {
		t.Fatalf("edit must land: %v", err)
	}
	want := "start ‘q’ X end ‘r’  \n"
	if newContent != want {
		t.Fatalf("bytes outside the match were rewritten:\n got %q\nwant %q", newContent, want)
	}
}

// F1-1 (cross-line): a fuzzy edit must not touch other lines at all,
// whatever characters they hold (NBSP, emoji, trailing spaces).
func TestEditFuzzyMatchLeavesOtherLinesIntact(t *testing.T) {
	content := "a b\ntrail   \n😀\ntarget ‘x’ line\n"
	edits := []textEdit{{OldText: "target 'x' line", NewText: "X"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	if err != nil {
		t.Fatalf("edit must land: %v", err)
	}
	want := "a b\ntrail   \n😀\nX\n"
	if newContent != want {
		t.Fatalf("untouched lines were rewritten:\n got %q\nwant %q", newContent, want)
	}
}

// F1-2: a whitespace-only old_text that does not exist in the file must be
// reported as not found — never matched as an empty span at offset 0.
func TestEditWhitespaceOnlyOldTextNeverMatchesEmptySpan(t *testing.T) {
	content := "abc\ndef\n"
	edits := []textEdit{{OldText: "  ", NewText: "X"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	if err == nil {
		t.Fatalf("degenerate old_text must not match, got content %q", newContent)
	}
	if !strings.Contains(err.Error(), "Could not find") {
		t.Fatalf("want a not-found error, got: %v", err)
	}
}

// F1-2 (variant): whitespace-only old_text ending in a newline.
func TestEditWhitespaceOnlyOldTextWithNewlineNeverMatches(t *testing.T) {
	content := "abc\ndef\n"
	edits := []textEdit{{OldText: "  \n", NewText: "X"}}
	if _, _, err := applyEditsToNormalizedContent(content, edits, "f.txt"); err == nil {
		t.Fatal("degenerate old_text must not match")
	}
}

// F1-3: text that exists exactly once must be accepted even when a fuzzy
// twin (smart quote / dash / trailing-space variant) exists elsewhere.
func TestEditUniqueExactTextNotBlockedByFuzzyTwin(t *testing.T) {
	_, out, err := applyEditsToNormalizedContent("x  \nx\n", []textEdit{{OldText: "x  ", NewText: "y"}}, "f.txt")
	if err != nil || out != "y\nx\n" {
		t.Fatalf("trailing-space twin: err=%v out=%q", err, out)
	}
	_, out, err = applyEditsToNormalizedContent("foo‘\nfoo'\n", []textEdit{{OldText: "foo‘", NewText: "bar"}}, "f.txt")
	if err != nil || out != "bar\nfoo'\n" {
		t.Fatalf("smart-quote twin: err=%v out=%q", err, out)
	}
	_, out, err = applyEditsToNormalizedContent("alpha-beta\nalpha—beta\n", []textEdit{{OldText: "alpha-beta", NewText: "gamma"}}, "f.txt")
	if err != nil || out != "gamma\nalpha—beta\n" {
		t.Fatalf("dash twin: err=%v out=%q", err, out)
	}
	// The exact twin on the other line is accepted just as well.
	_, out, err = applyEditsToNormalizedContent("alpha-beta\nalpha—beta\n", []textEdit{{OldText: "alpha—beta", NewText: "gamma"}}, "f.txt")
	if err != nil || out != "alpha-beta\ngamma\n" {
		t.Fatalf("exact smart-dash twin: err=%v out=%q", err, out)
	}
}

// F1-3 (variant): a fuzzy-only match is still unique when only ONE region
// folds to the pattern — and genuinely ambiguous fuzzy text (two regions
// fold to the same pattern) is still rejected.
func TestEditFuzzyUniqueMatchLands(t *testing.T) {
	// Neither line matches exactly, but BOTH fold to "alpha-beta" ->
	// genuinely ambiguous in the space the match was found in.
	ambiguous := "alpha—beta\nalpha‐beta\n"
	if _, _, err := applyEditsToNormalizedContent(ambiguous, []textEdit{{OldText: "alpha–beta", NewText: "X"}}, "f.txt"); err == nil {
		t.Fatal("fuzzy-ambiguous text must be rejected")
	}
	// Unique after folding.
	_, out, err := applyEditsToNormalizedContent("alpha—beta\ngamma\n", []textEdit{{OldText: "alpha-beta", NewText: "X"}}, "f.txt")
	if err != nil || out != "X\ngamma\n" {
		t.Fatalf("unique fuzzy match: err=%v out=%q", err, out)
	}
}

// A fuzzy match must span exactly the original bytes of the match —
// including multi-byte runes inside it.
func TestEditFuzzyMatchSpansOriginalBytes(t *testing.T) {
	content := "pre ‘quoted–text’ post\n"
	// old_text differs in quote AND dash style -> fuzzy; the match must
	// cover exactly "‘quoted–text’".
	edits := []textEdit{{OldText: "'quoted-text'", NewText: "X"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	if err != nil {
		t.Fatalf("edit must land: %v", err)
	}
	want := "pre X post\n"
	if newContent != want {
		t.Fatalf("match span wrong:\n got %q\nwant %q", newContent, want)
	}
}

// Indent-tolerant fallback combined with fuzzy characters.
func TestEditIndentTolerantWithFuzzyCharacters(t *testing.T) {
	content := "func f() {\n\t\treturn ‘1’\n}\n"
	edits := []textEdit{{OldText: "  return '1'", NewText: "  return '2'"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	if err != nil {
		t.Fatalf("edit must land: %v", err)
	}
	want := "func f() {\n\t\treturn '2'\n}\n"
	if newContent != want {
		t.Fatalf("indent transfer with fuzzy chars:\n got %q\nwant %q", newContent, want)
	}
}

// The whole batch applies when one edit is a no-op (old == new).
func TestEditBatchWithNoOpEditStillApplies(t *testing.T) {
	content := "aaa\nbbb\n"
	edits := []textEdit{
		{OldText: "aaa", NewText: "aaa"},
		{OldText: "bbb", NewText: "ccc"},
	}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	if err != nil || newContent != "aaa\nccc\n" {
		t.Fatalf("batch with no-op edit: err=%v out=%q", err, newContent)
	}
}

// CRLF files: fuzzy matching preserves CRLF endings and untouched bytes.
func TestEditFuzzyPreservesCRLF(t *testing.T) {
	content := "start ‘q’ fuzzy–target end\r\nkeep\r\n"
	edits := []textEdit{{OldText: "fuzzy-target", NewText: "X"}}
	_, newContent, err := applyEditsToNormalizedContent(content, edits, "f.txt")
	if err != nil {
		t.Fatalf("edit must land: %v", err)
	}
	want := "start ‘q’ X end\r\nkeep\r\n"
	if newContent != want {
		t.Fatalf("CRLF fuzzy edit:\n got %q\nwant %q", newContent, want)
	}
}
