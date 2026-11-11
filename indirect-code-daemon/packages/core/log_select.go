package core

import (
	"fmt"
	"regexp"
	"strings"
)

const (
	logSelectMinLines        = 50
	logSelectDefaultMaxLines = 100
	logSelectErrorContext    = 3
	logSelectHeadFrames      = 3
	logSelectAppFrames       = 5
	logSelectHeadAnchor      = 4
	logSelectTailAnchor      = 6
)

var (
	reErrorWord      = regexp.MustCompile(`(?i)(?:^|[^a-z0-9_])(error|errors|err|fatal|fatalf|panic|panicked|exception|segfault|sigsegv|sigabrt|traceback)(?:$|[^a-z0-9_])`)
	reErrorClass     = regexp.MustCompile(`(?i)[a-z0-9_]+(Error|Exception)\b`)
	reCompilerDiag   = regexp.MustCompile(`(?i)(?:\.(?:go|ts|tsx|js|jsx|rs|py|c|cc|cpp|h|hpp|java|cs):\d+:\d+:\s+\S+|undefined reference to|\bundefined:\s+[a-zA-Z_]|\bcannot (?:use|find|assign|convert)\b)`)
	reFailWord       = regexp.MustCompile(`(?i)(?:^|[^a-z0-9_])(fail|failed|failure|failures)(?:$|[^a-z0-9_])`)
	reZeroBenign     = regexp.MustCompile(`(?i)\b(?:0|no)\s+(?:error|errors|fail|failed|failure|failures)\b`)
	reNonZeroExit    = regexp.MustCompile(`(?i)(?:exit\s+(?:code|status)\s*:?\s*[1-9]\d*|\[exit\s+[1-9]\d*\])`)
	reWarnWord       = regexp.MustCompile(`(?i)(?:^|[^a-z0-9_])(warn|warning|warnings|deprecated)(?:$|[^a-z0-9_])`)
	reRunnerSummary  = regexp.MustCompile(`(?i)^\s*(?:FAIL\b|Tests:\s+|Test Suites:\s+|Ran \d+ tests|={3,}\s+short test summary|Summary\b)`)
	reGoGoroutine    = regexp.MustCompile(`^goroutine \d+ \[.*\]:`)
	reGoFileLine     = regexp.MustCompile(`^\t[^\t]+\.go:\d+`)
	reJSAtFrame      = regexp.MustCompile(`^\s+at\s+\S+`)
	rePyFileFrame    = regexp.MustCompile(`^\s*File "[^"]+", line \d+`)
	reRustNumFrame   = regexp.MustCompile(`^\s*\d+:\s+\S+`)
	reRustAtFrame    = regexp.MustCompile(`^\s+at\s+.*\.rs:\d+`)
	reDotNetAtFrame  = regexp.MustCompile(`^\s+at\s+[\w.<>` + "`" + `]+\(.*\)`)
	reJavaMoreFrames = regexp.MustCompile(`^\s+\.\.\. \d+ more\s*$`)
)

// LogSelect deterministically condenses long build, test, and runtime logs
// (>= 50 lines) to at most maxLines lines while preserving every error,
// failure, fatal, panic, and exception line with ±3 context lines, warnings,
// and application stack-trace frames across Go, JS/TS, Python, Rust, and
// Java/.NET.
//
// Invariant (errorLinesSurvive): if ANY error/fail/fatal/panic/exception line
// from text would be omitted, LogSelect fails open and returns (text, false).
func LogSelect(text string, maxLines int) (string, bool) {
	if maxLines <= 0 {
		maxLines = logSelectDefaultMaxLines
	}
	if text == "" {
		return text, false
	}

	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")
	n := len(lines)
	if n < logSelectMinLines || n <= maxLines {
		return text, false
	}

	// Priority tiers:
	// 4 = mandatory error/fail/panic/fatal/exception line (never dropped)
	// 3 = ±3 context around error lines + stack headers + selected stack frames
	// 2 = head/tail anchors + warnings + build/test summary lines
	// 1 = ±1 context around warnings
	// 0 = collapsible noise / runtime frames
	prio := make([]uint8, n)
	isErr := make([]bool, n)
	mandatoryCount := 0

	setPrio := func(idx int, p uint8) {
		if idx >= 0 && idx < n && p > prio[idx] {
			prio[idx] = p
		}
	}

	for i, line := range lines {
		if isLogErrorLine(line) {
			isErr[i] = true
			prio[i] = 4
			mandatoryCount++
		} else if isLogWarningLine(line) || reRunnerSummary.MatchString(line) {
			setPrio(i, 2)
		}
	}

	// Fast fail-open if mandatory error lines alone exceed maxLines.
	if mandatoryCount > maxLines {
		return text, false
	}

	// Mark ±3 context around every error line and ±1 around warning lines.
	for i := 0; i < n; i++ {
		if isErr[i] {
			for d := -logSelectErrorContext; d <= logSelectErrorContext; d++ {
				if d != 0 {
					setPrio(i+d, 3)
				}
			}
		} else if prio[i] == 2 && isLogWarningLine(lines[i]) {
			setPrio(i-1, 1)
			setPrio(i+1, 1)
		}
	}

	// Detect and score stack-trace blocks (Go, JS/TS, Python, Rust, Java/.NET):
	// preserve trace headers, first 3 head frames, and up to 5 application frames,
	// collapsing excess stdlib/runtime frames into gap markers.
	markStackTraceFrames(lines, setPrio)

	// Mark head and tail anchors.
	for i := 0; i < logSelectHeadAnchor && i < n; i++ {
		setPrio(i, 2)
	}
	for i := max(0, n-logSelectTailAnchor); i < n; i++ {
		setPrio(i, 2)
	}

	keep := make([]bool, n)
	for i := 0; i < n; i++ {
		if prio[i] == 4 {
			keep[i] = true
		}
	}

	// Check if mandatory lines + gap markers already exceed maxLines.
	if renderedLineCount(keep) > maxLines {
		return text, false
	}

	// Greedily add lower priority tiers (3 -> 2 -> 1) in deterministic order.
	for _, tier := range []uint8{3, 2, 1} {
		// Gather candidates in this tier. For tier 2, prefer tail anchors first
		// so final exit summaries land reliably.
		candidates := orderedTierCandidates(prio, tier)
		for _, idx := range candidates {
			if keep[idx] {
				continue
			}
			keep[idx] = true
			if renderedLineCount(keep) > maxLines {
				keep[idx] = false
			}
		}
	}

	outLines := renderSelectedLines(lines, keep)
	if len(outLines) >= n || len(outLines) > maxLines {
		return text, false
	}
	if !errorLinesSurvive(lines, isErr, outLines) {
		return text, false
	}
	return strings.Join(outLines, "\n"), true
}

func orderedTierCandidates(prio []uint8, tier uint8) []int {
	n := len(prio)
	out := make([]int, 0, 32)
	if tier == 2 && n > logSelectTailAnchor {
		for i := n - logSelectTailAnchor; i < n; i++ {
			if prio[i] == tier {
				out = append(out, i)
			}
		}
		for i := 0; i < n-logSelectTailAnchor; i++ {
			if prio[i] == tier {
				out = append(out, i)
			}
		}
		return out
	}
	for i := 0; i < n; i++ {
		if prio[i] == tier {
			out = append(out, i)
		}
	}
	return out
}

func isLogErrorLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return false
	}
	// Pytest failure diff lines begin with "E   ".
	if strings.HasPrefix(trimmed, "E   ") {
		return true
	}
	if strings.HasPrefix(trimmed, "Caused by:") || strings.HasPrefix(trimmed, "Traceback (most recent call last):") {
		return true
	}
	if reNonZeroExit.MatchString(trimmed) {
		return true
	}
	if reErrorClass.MatchString(trimmed) || reCompilerDiag.MatchString(trimmed) {
		return true
	}

	hasErr := reErrorWord.MatchString(trimmed)
	hasFail := reFailWord.MatchString(trimmed)
	if !hasErr && !hasFail {
		return false
	}
	// Exclude purely benign summary counts like "0 errors, 0 failed" when no
	// actual failure token remains after stripping benign zero-count phrases.
	if reZeroBenign.MatchString(trimmed) {
		cleaned := reZeroBenign.ReplaceAllString(trimmed, " ")
		if !reErrorWord.MatchString(cleaned) && !reFailWord.MatchString(cleaned) && !reErrorClass.MatchString(cleaned) {
			return false
		}
	}
	return true
}

func isLogWarningLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return false
	}
	return reWarnWord.MatchString(trimmed)
}

type stackFrameSpan struct {
	start    int
	end      int // inclusive
	isStdlib bool
}

func markStackTraceFrames(lines []string, setPrio func(idx int, p uint8)) {
	n := len(lines)
	i := 0
	for i < n {
		if reGoGoroutine.MatchString(lines[i]) {
			setPrio(i, 3)
			i++
			var frames []stackFrameSpan
			for i < n {
				if i+1 < n && !strings.HasPrefix(lines[i], "\t") && strings.TrimSpace(lines[i]) != "" && reGoFileLine.MatchString(lines[i+1]) {
					std := isStdlibStackLine(lines[i]) || isStdlibStackLine(lines[i+1])
					frames = append(frames, stackFrameSpan{start: i, end: i + 1, isStdlib: std})
					i += 2
					continue
				}
				break
			}
			applyFrameSelection(frames, setPrio)
			continue
		}

		if sp, ok := matchSingleStackFrame(lines, i); ok {
			var frames []stackFrameSpan
			frames = append(frames, sp)
			i = sp.end + 1
			for i < n {
				if next, ok2 := matchSingleStackFrame(lines, i); ok2 {
					frames = append(frames, next)
					i = next.end + 1
					continue
				}
				if reJavaMoreFrames.MatchString(lines[i]) {
					i++
					continue
				}
				break
			}
			applyFrameSelection(frames, setPrio)
			continue
		}
		i++
	}
}

func matchSingleStackFrame(lines []string, i int) (stackFrameSpan, bool) {
	line := lines[i]
	// Python: `  File "...", line N, in fn` (+ optional indented code line)
	if rePyFileFrame.MatchString(line) {
		end := i
		if i+1 < len(lines) {
			next := lines[i+1]
			if strings.HasPrefix(next, "    ") && !rePyFileFrame.MatchString(next) && !isLogErrorLine(next) {
				end = i + 1
			}
		}
		return stackFrameSpan{start: i, end: end, isStdlib: isStdlibStackLine(line)}, true
	}
	// Rust numbered frame: `   4: my_crate::run` (+ optional `             at ./src/main.rs:12:5`)
	if reRustNumFrame.MatchString(line) {
		end := i
		std := isStdlibStackLine(line)
		if i+1 < len(lines) && reRustAtFrame.MatchString(lines[i+1]) {
			end = i + 1
			std = std || isStdlibStackLine(lines[i+1])
		}
		return stackFrameSpan{start: i, end: end, isStdlib: std}, true
	}
	// JS/TS, Java, .NET, Rust `  at ...`
	if reJSAtFrame.MatchString(line) || reDotNetAtFrame.MatchString(line) || reRustAtFrame.MatchString(line) {
		return stackFrameSpan{start: i, end: i, isStdlib: isStdlibStackLine(line)}, true
	}
	return stackFrameSpan{}, false
}

func applyFrameSelection(frames []stackFrameSpan, setPrio func(idx int, p uint8)) {
	appKept := 0
	for idx, f := range frames {
		selectFrame := false
		if idx < logSelectHeadFrames {
			selectFrame = true
		} else if !f.isStdlib && appKept < logSelectAppFrames {
			selectFrame = true
			appKept++
		}
		if selectFrame {
			for lineIdx := f.start; lineIdx <= f.end; lineIdx++ {
				setPrio(lineIdx, 3)
			}
		}
	}
}

func isStdlibStackLine(line string) bool {
	s := strings.ReplaceAll(line, "\\", "/")
	stdlibMarkers := []string{
		"node_modules/",
		"node:internal/",
		"(internal/",
		"bun:internal",
		"/go/src/",
		"/libexec/src/runtime/",
		"runtime.goexit",
		"runtime.main",
		"testing.tRunner",
		"/site-packages/",
		"/dist-packages/",
		"/lib/python",
		"<frozen ",
		"/rustc/",
		"std::rt::",
		"std::panicking::",
		"core::ops::function",
		"__rust_begin_short_backtrace",
		"java.base/",
		"sun.reflect.",
		"jdk.internal.",
		"org.junit.",
		"at System.",
		"at Microsoft.",
	}
	for _, m := range stdlibMarkers {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}

func renderedLineCount(keep []bool) int {
	count := 0
	inGap := false
	for _, k := range keep {
		if k {
			count++
			inGap = false
		} else if !inGap {
			count++
			inGap = true
		}
	}
	return count
}

func renderSelectedLines(lines []string, keep []bool) []string {
	out := make([]string, 0, len(lines)/2)
	i := 0
	n := len(lines)
	for i < n {
		if keep[i] {
			out = append(out, lines[i])
			i++
			continue
		}
		gapStart := i
		for i < n && !keep[i] {
			i++
		}
		omitted := i - gapStart
		if omitted == 1 {
			out = append(out, lines[gapStart])
		} else {
			out = append(out, fmt.Sprintf("[... %d lines omitted ...]", omitted))
		}
	}
	return out
}

func errorLinesSurvive(inputLines []string, isErr []bool, outLines []string) bool {
	outPos := 0
	for i, line := range inputLines {
		if !isErr[i] {
			continue
		}
		found := false
		for outPos < len(outLines) {
			if outLines[outPos] == line {
				outPos++
				found = true
				break
			}
			outPos++
		}
		if !found {
			return false
		}
	}
	return true
}
