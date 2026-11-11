package tools

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"indirect/indirect-code-daemon/internal/durable"
	"indirect/indirect-code-daemon/packages/core"
)

const (
	// ArrivalSpillThresholdBytes is the foreground synchronous output size
	// above which BashTool, ExecScriptTool, and FetchURLTool spill the full
	// lossless output to <BrainDir>/tool-<sanitizedCallID>.log and return a
	// compact inline preview to the LLM.
	ArrivalSpillThresholdBytes = 20 * 1024

	arrivalSpillHeadLines     = 35
	arrivalSpillTailLines     = 25
	arrivalSpillContextRadius = 2

	arrivalSpillHeadBudgetBytes   = 2200
	arrivalSpillMiddleBudgetBytes = 1800
	arrivalSpillTailBudgetBytes   = 1600
	arrivalSpillMaxPreviewBytes   = 6 * 1024
)

var arrivalSpillFallbackSeq atomic.Uint64

type arrivalSpillResult struct {
	Path    string
	Preview string
	Lines   int
	Bytes   int
}

// maybeSpillOutput atomically writes fullText to <brainDir>/tool-<callID>.log
// when brainDir is configured and len(fullText) > ArrivalSpillThresholdBytes.
// On write error it fails open (returns ok=false) so tool execution still succeeds.
func maybeSpillOutput(ctx context.Context, brainDir string, fullText string) (arrivalSpillResult, bool) {
	cleanBrain := strings.TrimSpace(brainDir)
	if cleanBrain == "" || len(fullText) <= ArrivalSpillThresholdBytes {
		return arrivalSpillResult{}, false
	}
	cleanBrain = filepath.Clean(cleanBrain)

	callID := core.ToolCallID(ctx)
	if callID == "" {
		callID = core.ExecutionID(ctx)
	}
	safeID := sanitizeSpillCallID(callID)
	spillPath := filepath.Join(cleanBrain, "tool-"+safeID+".log")
	if filepath.Clean(filepath.Dir(spillPath)) != cleanBrain {
		return arrivalSpillResult{}, false
	}

	if err := durable.Write(spillPath, []byte(fullText)); err != nil {
		return arrivalSpillResult{}, false
	}

	preview, totalLines, totalBytes := buildArrivalSpillPreview(fullText, spillPath)
	return arrivalSpillResult{
		Path:    spillPath,
		Preview: preview,
		Lines:   totalLines,
		Bytes:   totalBytes,
	}, true
}

// applySpillAttrs updates envelope attrs for a spilled tool result, preserving
// command status/exit/duration attrs while marking truncated=true and spilled=true.
func applySpillAttrs(attrs []core.Attr, res arrivalSpillResult) []core.Attr {
	out := make([]core.Attr, 0, len(attrs)+2)
	hasTruncated := false
	for _, a := range attrs {
		switch a.Key {
		case "page", "next", "partial_last_line", "dropped_bytes", "info":
			// Superseded by the spilled head+diagnostics+tail preview.
			continue
		case "truncated":
			out = append(out, core.Attr{Key: "truncated", Value: "true"})
			hasTruncated = true
		default:
			out = append(out, a)
		}
	}
	if !hasTruncated {
		out = append([]core.Attr{{Key: "truncated", Value: "true"}}, out...)
	}
	out = append(out, core.Attr{Key: "spilled", Value: "true"})
	return out
}

// sanitizeSpillCallID normalizes a tool call ID into a safe flat filename stem.
func sanitizeSpillCallID(callID string) string {
	trimmed := strings.TrimSpace(callID)
	if trimmed != "" {
		var b strings.Builder
		b.Grow(len(trimmed))
		for _, r := range trimmed {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
				b.WriteRune(r)
			} else {
				b.WriteByte('_')
			}
		}
		cleaned := strings.Trim(b.String(), "._-")
		if len(cleaned) > 80 {
			cleaned = strings.Trim(cleaned[:80], "._-")
		}
		if cleaned != "" {
			return cleaned
		}
	}
	seq := arrivalSpillFallbackSeq.Add(1)
	return fmt.Sprintf("call-%d-%d", time.Now().UnixNano(), seq)
}

type lineSpan struct {
	start int // inclusive 0-based line index
	end   int // inclusive 0-based line index
}

// buildArrivalSpillPreview constructs a compact (~4KB–6KB) deterministic preview:
// [head 35 lines] + [extracted error/fail/panic/traceback lines with ±2 context]
// + [tail 25 lines] + [Full output saved to <path> (N lines, B bytes) — ...].
func buildArrivalSpillPreview(fullText, spillPath string) (string, int, int) {
	totalBytes := len(fullText)
	totalLines := countLogicalLines(fullText)
	footer := fmt.Sprintf("[Full output saved to %s (%d lines, %d bytes) — use read/search on this file if more lines are needed]",
		spillPath, totalLines, totalBytes)

	trimmed := strings.TrimSuffix(fullText, "\n")
	if trimmed == "" {
		return footer, totalLines, totalBytes
	}
	lines := strings.Split(trimmed, "\n")
	n := len(lines)

	// Single-line or ultra-few-line giant payload (e.g. minified JSON): show
	// bounded head + tail slices of the raw text so preview stays ~4KB–6KB.
	if n == 1 && len(lines[0]) > arrivalSpillHeadBudgetBytes+arrivalSpillTailBudgetBytes {
		line := lines[0]
		head := snapUTF8Prefix(line, arrivalSpillHeadBudgetBytes)
		tail := snapUTF8Suffix(line, arrivalSpillTailBudgetBytes)
		omitted := len(line) - len(head) - len(tail)
		if omitted < 0 {
			omitted = 0
		}
		var sb strings.Builder
		sb.WriteString(head)
		fmt.Fprintf(&sb, "\n... [%d bytes omitted on line 1] ...\n", omitted)
		sb.WriteString(tail)
		sb.WriteString("\n\n")
		sb.WriteString(footer)
		return enforcePreviewCeiling(sb.String(), footer), totalLines, totalBytes
	}

	headEnd := arrivalSpillHeadLines
	if headEnd > n {
		headEnd = n
	}
	tailStart := n - arrivalSpillTailLines
	if tailStart < headEnd {
		tailStart = headEnd
	}

	renderPass := func(lineCap, headBudget, midBudget, tailBudget int) string {
		headRendered, headShown := renderHeadLines(lines[:headEnd], lineCap, headBudget)
		tailRendered, tailActualStart := renderTailLines(lines, tailStart, n, lineCap, tailBudget)

		midStart := headShown
		midEnd := tailActualStart
		if midEnd < midStart {
			midEnd = midStart
		}
		midLineCount := midEnd - midStart

		middleSection := ""
		if midLineCount > 0 {
			diagBody, diagSpans, omittedSpans := renderMiddleDiagnostics(lines, midStart, midEnd, lineCap, midBudget)
			if diagSpans > 0 {
				var mb strings.Builder
				fmt.Fprintf(&mb, "--- [middle: %d lines (L%d-L%d); extracted error/failure context (±%d lines)] ---\n",
					midLineCount, midStart+1, midEnd, arrivalSpillContextRadius)
				mb.WriteString(diagBody)
				if omittedSpans > 0 {
					fmt.Fprintf(&mb, "\n... (%d more diagnostic span(s) in saved file)", omittedSpans)
				}
				middleSection = mb.String()
			} else {
				middleSection = fmt.Sprintf("--- [middle: %d lines omitted (L%d-L%d)] ---", midLineCount, midStart+1, midEnd)
			}
		}

		var sb strings.Builder
		if headRendered != "" {
			sb.WriteString(headRendered)
		}
		if middleSection != "" {
			if sb.Len() > 0 {
				sb.WriteString("\n")
			}
			sb.WriteString(middleSection)
		}
		if tailRendered != "" {
			if sb.Len() > 0 {
				sb.WriteString("\n")
			}
			if midLineCount > 0 {
				fmt.Fprintf(&sb, "--- [tail: last %d line(s) (L%d-L%d)] ---\n", n-tailActualStart, tailActualStart+1, n)
			}
			sb.WriteString(tailRendered)
		}
		if sb.Len() > 0 {
			sb.WriteString("\n\n")
		}
		sb.WriteString(footer)
		return sb.String()
	}

	lineCap := 160
	if n <= 5 {
		lineCap = 900
	}
	candidate := renderPass(lineCap, 4200, arrivalSpillMiddleBudgetBytes, 3000)
	if len(candidate) > arrivalSpillMaxPreviewBytes {
		candidate = renderPass(76, 3000, 750, 2100)
	}
	return enforcePreviewCeiling(candidate, footer), totalLines, totalBytes
}

func renderHeadLines(lines []string, lineCap, budget int) (string, int) {
	var out []string
	used := 0
	for i, ln := range lines {
		clipped := clipPreviewLine(ln, lineCap)
		cost := len(clipped) + 1
		if i > 0 && used+cost > budget {
			return strings.Join(out, "\n"), i
		}
		out = append(out, clipped)
		used += cost
	}
	return strings.Join(out, "\n"), len(lines)
}

func renderTailLines(allLines []string, tailStart, n, lineCap, budget int) (string, int) {
	if tailStart >= n {
		return "", n
	}
	var rev []string
	used := 0
	actualStart := n
	for i := n - 1; i >= tailStart; i-- {
		clipped := clipPreviewLine(allLines[i], lineCap)
		cost := len(clipped) + 1
		if len(rev) > 0 && used+cost > budget {
			break
		}
		rev = append(rev, clipped)
		used += cost
		actualStart = i
	}
	for l, r := 0, len(rev)-1; l < r; l, r = l+1, r-1 {
		rev[l], rev[r] = rev[r], rev[l]
	}
	return strings.Join(rev, "\n"), actualStart
}

func renderMiddleDiagnostics(lines []string, midStart, midEnd, lineCap, budget int) (body string, includedSpans int, omittedSpans int) {
	var rawSpans []lineSpan
	for idx := midStart; idx < midEnd; idx++ {
		if !isDiagnosticErrorLine(lines[idx]) {
			continue
		}
		s := idx - arrivalSpillContextRadius
		if s < midStart {
			s = midStart
		}
		e := idx + arrivalSpillContextRadius
		if e >= midEnd {
			e = midEnd - 1
		}
		if len(rawSpans) > 0 && s <= rawSpans[len(rawSpans)-1].end+1 {
			if e > rawSpans[len(rawSpans)-1].end {
				rawSpans[len(rawSpans)-1].end = e
			}
		} else {
			rawSpans = append(rawSpans, lineSpan{start: s, end: e})
		}
	}
	if len(rawSpans) == 0 {
		return "", 0, 0
	}

	var renderedSpans []string
	used := 0
	for spanIdx, sp := range rawSpans {
		var spanLines []string
		for lineIdx := sp.start; lineIdx <= sp.end; lineIdx++ {
			prefix := fmt.Sprintf("L%d: ", lineIdx+1)
			spanLines = append(spanLines, prefix+clipPreviewLine(lines[lineIdx], lineCap))
		}
		block := strings.Join(spanLines, "\n")
		sepLen := 0
		if len(renderedSpans) > 0 {
			sepLen = 5 // "\n...\n"
		}
		if used+sepLen+len(block) > budget {
			// If even the first span exceeds budget because it coalesced many
			// lines, keep only the anchor diagnostic lines inside this span.
			if len(renderedSpans) == 0 {
				var anchors []string
				for lineIdx := sp.start; lineIdx <= sp.end; lineIdx++ {
					if !isDiagnosticErrorLine(lines[lineIdx]) {
						continue
					}
					entry := fmt.Sprintf("L%d: %s", lineIdx+1, clipPreviewLine(lines[lineIdx], lineCap))
					if used+len(entry)+1 > budget && len(anchors) > 0 {
						break
					}
					anchors = append(anchors, entry)
					used += len(entry) + 1
				}
				if len(anchors) > 0 {
					renderedSpans = append(renderedSpans, strings.Join(anchors, "\n"))
					includedSpans++
					omittedSpans = len(rawSpans) - 1
					break
				}
			}
			omittedSpans = len(rawSpans) - spanIdx
			break
		}
		renderedSpans = append(renderedSpans, block)
		used += sepLen + len(block)
		includedSpans++
	}

	return strings.Join(renderedSpans, "\n...\n"), includedSpans, omittedSpans
}

// isDiagnosticErrorLine deterministically identifies error, failure, panic,
// exception, and traceback anchor lines without regex backtracking.
func isDiagnosticErrorLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return false
	}
	if strings.HasPrefix(trimmed, "--- FAIL:") ||
		strings.HasPrefix(trimmed, "FAIL\t") ||
		strings.HasPrefix(trimmed, "FAIL:") ||
		trimmed == "FAIL" {
		return true
	}

	lower := strings.ToLower(trimmed)

	// Exclude common benign summary lines so "0 errors, 0 failed" is not noisy.
	if strings.Contains(lower, "0 error") ||
		strings.Contains(lower, "0 failed") ||
		strings.Contains(lower, "0 failures") ||
		strings.Contains(lower, "no error") ||
		strings.Contains(lower, "without error") ||
		strings.Contains(lower, "error=nil") ||
		strings.Contains(lower, "err=nil") ||
		strings.Contains(lower, "errors: 0") ||
		strings.Contains(lower, "failed: 0") {
		return false
	}

	substrings := []string{
		"panic:",
		"fatal:",
		"fatal error",
		"traceback (most recent call last)",
		"segmentation fault",
		"sigsegv",
		"syntaxerror",
		"typeerror",
		"referenceerror",
		"assertionerror",
		"unhandledpromiserejection",
		"caused by:",
		": error:",
		": error[",
		"error ts",
	}
	for _, needle := range substrings {
		if strings.Contains(lower, needle) {
			return true
		}
	}

	if strings.HasPrefix(lower, "error:") ||
		strings.HasPrefix(lower, "error ") ||
		strings.HasPrefix(lower, "error[") ||
		strings.HasPrefix(lower, "err:") {
		return true
	}

	return hasDiagnosticWord(lower, "error") ||
		hasDiagnosticWord(lower, "failed") ||
		hasDiagnosticWord(lower, "failure") ||
		hasDiagnosticWord(lower, "exception") ||
		hasDiagnosticWord(lower, "panic") ||
		hasDiagnosticWord(lower, "traceback")
}

func hasDiagnosticWord(lowerLine, word string) bool {
	offset := 0
	for {
		idx := strings.Index(lowerLine[offset:], word)
		if idx < 0 {
			return false
		}
		pos := offset + idx
		end := pos + len(word)
		leftOK := pos == 0 || !isWordChar(rune(lowerLine[pos-1]))
		rightOK := end == len(lowerLine) || !isWordChar(rune(lowerLine[end]))
		if leftOK && rightOK {
			return true
		}
		offset = pos + len(word)
	}
}

func isWordChar(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_'
}

func countLogicalLines(s string) int {
	if s == "" {
		return 0
	}
	n := strings.Count(s, "\n")
	if !strings.HasSuffix(s, "\n") {
		n++
	}
	return n
}

func clipPreviewLine(line string, maxBytes int) string {
	line = strings.TrimRight(line, "\r")
	if len(line) <= maxBytes {
		return line
	}
	const suffix = " … [line truncated]"
	budget := maxBytes - len(suffix)
	if budget < 16 {
		budget = 16
	}
	return snapUTF8Prefix(line, budget) + suffix
}

func snapUTF8Prefix(s string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(s) <= maxBytes {
		return s
	}
	end := maxBytes
	for end > 0 && !utf8.RuneStart(s[end]) {
		end--
	}
	return s[:end]
}

func snapUTF8Suffix(s string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(s) <= maxBytes {
		return s
	}
	start := len(s) - maxBytes
	for start < len(s) && !utf8.RuneStart(s[start]) {
		start++
	}
	return s[start:]
}

func enforcePreviewCeiling(preview, footer string) string {
	if len(preview) <= arrivalSpillMaxPreviewBytes {
		return preview
	}
	const marker = "\n... [preview clipped] ...\n\n"
	room := arrivalSpillMaxPreviewBytes - len(footer) - len(marker)
	if room <= 0 {
		return snapUTF8Prefix(footer, arrivalSpillMaxPreviewBytes)
	}
	return snapUTF8Prefix(preview, room) + marker + footer
}
