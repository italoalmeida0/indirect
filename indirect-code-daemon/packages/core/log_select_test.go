package core

import (
	"fmt"
	"strings"
	"testing"
)

func TestLogSelectSkipsShortLogs(t *testing.T) {
	var lines []string
	for i := 0; i < 49; i++ {
		lines = append(lines, fmt.Sprintf("step %d: ok", i))
	}
	short := strings.Join(lines, "\n")
	got, changed := LogSelect(short, 20)
	if changed || got != short {
		t.Fatalf("logs < 50 lines must stay untouched: changed=%v", changed)
	}
}

func TestLogSelectPreservesErrorsContextAndAppFramesAcrossLanguages(t *testing.T) {
	var lines []string
	lines = append(lines, "$ go test ./... && bun test && pytest")
	for i := 1; i <= 40; i++ {
		lines = append(lines, fmt.Sprintf("=== RUN   TestPassingCase%02d", i))
		lines = append(lines, fmt.Sprintf("--- PASS: TestPassingCase%02d (0.01s)", i))
	}
	lines = append(lines, "WARN: deprecated config flag --legacy-cache used")
	for i := 1; i <= 25; i++ {
		lines = append(lines, fmt.Sprintf("info: compiling module_%02d.go", i))
	}
	// Error with ±3 context lines
	lines = append(lines, "ctx-before-3")
	lines = append(lines, "ctx-before-2")
	lines = append(lines, "ctx-before-1")
	lines = append(lines, "--- FAIL: TestSessionCompaction (0.14s)")
	lines = append(lines, "    compaction_test.go:88: expected KeepFrom=12, got 0")
	lines = append(lines, "ctx-after-1")
	lines = append(lines, "ctx-after-2")
	lines = append(lines, "ctx-after-3")

	// Go panic + runtime vs app stack frames
	lines = append(lines, "panic: runtime error: index out of range [5] with length 3")
	lines = append(lines, "goroutine 42 [running]:")
	for i := 0; i < 10; i++ {
		lines = append(lines, fmt.Sprintf("runtime.internalHelper%d(0x0)", i))
		lines = append(lines, fmt.Sprintf("\t/usr/local/go/src/runtime/proc.go:%d +0x1a", 100+i))
	}
	lines = append(lines, "indirect/packages/core.projectMessages({0x14000, 0x5})")
	lines = append(lines, "\t/workspace/indirect/packages/core/compaction.go:142 +0x88")

	// JS/TS stack trace with node_modules noise + app frame
	lines = append(lines, "TypeError: Cannot read properties of undefined (reading 'blocks')")
	for i := 0; i < 12; i++ {
		lines = append(lines, fmt.Sprintf("    at runMicrotasks (/app/node_modules/scheduler/index.js:%d:10)", i+10))
	}
	lines = append(lines, "    at CompactionBalloon (/app/web/src/CompactionBalloon.tsx:44:17)")

	// Python traceback
	lines = append(lines, "Traceback (most recent call last):")
	for i := 0; i < 8; i++ {
		lines = append(lines, fmt.Sprintf(`  File "/usr/lib/python3.11/site-packages/pluggy/_callers.py", line %d, in _multicall`, 30+i))
		lines = append(lines, "    res = hook_impl.function(*args)")
	}
	lines = append(lines, `  File "/app/scripts/verify.py", line 91, in check_blocks`)
	lines = append(lines, "    assert len(blocks) > 0")
	lines = append(lines, "AssertionError: expected active blocks")

	// Rust panic + Java/.NET frames
	lines = append(lines, "thread 'worker-1' panicked at src/engine.rs:77:9: index out of bounds")
	for i := 0; i < 8; i++ {
		lines = append(lines, fmt.Sprintf("   %d: std::rt::lang_start_internal", i))
		lines = append(lines, fmt.Sprintf("             at /rustc/abc123/library/std/src/rt.rs:%d:5", 100+i))
	}
	lines = append(lines, "   9: my_daemon::engine::compact_span")
	lines = append(lines, "             at ./src/engine.rs:77:9")

	for i := 0; i < 30; i++ {
		lines = append(lines, fmt.Sprintf("cleanup line %d", i))
	}
	lines = append(lines, "FAIL\tindirect/packages/core\t0.412s")
	lines = append(lines, "[exit 1]")

	input := strings.Join(lines, "\n")
	out, changed := LogSelect(input, 95)
	if !changed {
		t.Fatalf("expected LogSelect to condense %d-line log", len(lines))
	}
	outLines := strings.Split(out, "\n")
	if len(outLines) > 95 {
		t.Fatalf("output exceeded maxLines=95: got %d", len(outLines))
	}

	mustContain := []string{
		"WARN: deprecated config flag --legacy-cache used",
		"ctx-before-3",
		"ctx-before-1",
		"--- FAIL: TestSessionCompaction (0.14s)",
		"ctx-after-1",
		"ctx-after-3",
		"panic: runtime error: index out of range [5] with length 3",
		"/workspace/indirect/packages/core/compaction.go:142",
		"TypeError: Cannot read properties of undefined",
		"/app/web/src/CompactionBalloon.tsx:44:17",
		"Traceback (most recent call last):",
		`/app/scripts/verify.py", line 91`,
		"AssertionError: expected active blocks",
		"thread 'worker-1' panicked at src/engine.rs:77:9",
		"my_daemon::engine::compact_span",
		"FAIL\tindirect/packages/core\t0.412s",
		"[exit 1]",
		"lines omitted",
	}
	for _, needle := range mustContain {
		if !strings.Contains(out, needle) {
			t.Fatalf("LogSelect dropped %q:\n%s", needle, out)
		}
	}

	// Deterministic across repeated calls.
	out2, changed2 := LogSelect(input, 95)
	if !changed2 || out2 != out {
		t.Fatal("LogSelect must be 100% deterministic")
	}
}

func TestLogSelectErrorLinesSurviveInvariantFailsOpen(t *testing.T) {
	var lines []string
	for i := 0; i < 120; i++ {
		lines = append(lines, fmt.Sprintf("ERROR: fatal failure #%03d in subsystem", i))
	}
	input := strings.Join(lines, "\n")

	// 120 mandatory error lines cannot fit in maxLines=60 -> MUST fail open!
	got, changed := LogSelect(input, 60)
	if changed || got != input {
		t.Fatalf("expected fail-open when error lines exceed maxLines: changed=%v", changed)
	}
}

func TestLogSelectJavaAndDotNetStackFrames(t *testing.T) {
	var lines []string
	lines = append(lines, "Starting integration suite...")
	for i := 0; i < 40; i++ {
		lines = append(lines, fmt.Sprintf("[INFO] worker step %d completed", i))
	}
	lines = append(lines, "java.lang.IllegalStateException: Actor mailbox closed")
	for i := 0; i < 8; i++ {
		lines = append(lines, fmt.Sprintf("    at java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke%d(NativeMethodAccessorImpl.java:%d)", i, 50+i))
	}
	lines = append(lines, "    at com.indirect.daemon.SessionActor.dispatch(SessionActor.java:188)")
	lines = append(lines, "    ... 14 more")
	lines = append(lines, "System.InvalidOperationException: Sequence contains no elements")
	for i := 0; i < 8; i++ {
		lines = append(lines, fmt.Sprintf("   at System.Linq.ThrowHelper.ThrowNoElementsException%d()", i))
	}
	lines = append(lines, "   at Indirect.Core.Compactor.FoldSpan() in /src/Compactor.cs:line 94")
	for i := 0; i < 20; i++ {
		lines = append(lines, fmt.Sprintf("[INFO] shutting down pool %d", i))
	}

	out, changed := LogSelect(strings.Join(lines, "\n"), 45)
	if !changed {
		t.Fatal("expected Java/.NET log to be condensed")
	}
	for _, needle := range []string{
		"java.lang.IllegalStateException: Actor mailbox closed",
		"com.indirect.daemon.SessionActor.dispatch(SessionActor.java:188)",
		"System.InvalidOperationException: Sequence contains no elements",
		"Indirect.Core.Compactor.FoldSpan() in /src/Compactor.cs:line 94",
	} {
		if !strings.Contains(out, needle) {
			t.Fatalf("missing Java/.NET frame %q:\n%s", needle, out)
		}
	}
}
