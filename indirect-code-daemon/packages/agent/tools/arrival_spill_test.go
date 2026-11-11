package tools

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	"indirect/indirect-code-daemon/packages/core"
)

func TestArrivalSpillPreviewStructureAndBounds(t *testing.T) {
	var sb strings.Builder
	for i := 1; i <= 500; i++ {
		switch i {
		case 180:
			sb.WriteString("step 180: completed 200 checks with 0 errors and 0 failed assertions\n")
		case 240:
			sb.WriteString("--- FAIL: TestSessionCompactionReplay (0.08s)\n")
		case 241:
			sb.WriteString("    replay_test.go:92: error: expected KeepFrom=18, got 4\n")
		default:
			fmt.Fprintf(&sb, "line-%03d: building package shard worker output payload segment %s\n", i, strings.Repeat("x", 32))
		}
	}
	full := sb.String()
	if len(full) <= ArrivalSpillThresholdBytes {
		t.Fatalf("fixture too small (%d bytes), must exceed %d", len(full), ArrivalSpillThresholdBytes)
	}

	spillPath := "/brain/session-1/tool-call_1.log"
	preview, lines, bytesCount := buildArrivalSpillPreview(full, spillPath)
	if lines != 500 || bytesCount != len(full) {
		t.Fatalf("counts = (%d lines, %d bytes), want (500, %d)", lines, bytesCount, len(full))
	}
	if len(preview) > arrivalSpillMaxPreviewBytes {
		t.Fatalf("preview exceeded 6KB ceiling: got %d bytes", len(preview))
	}
	if len(preview) < 2500 {
		t.Fatalf("preview unexpectedly tiny: got %d bytes", len(preview))
	}

	// Head 35 lines present; line 36 is in middle (omitted unless near error).
	if !strings.Contains(preview, "line-001:") || !strings.Contains(preview, "line-035:") {
		t.Fatalf("expected head 35 lines in preview:\n%s", preview)
	}
	if strings.Contains(preview, "line-036:") {
		t.Fatalf("line 36 should be in omitted middle:\n%s", preview)
	}
	// Benign "0 errors and 0 failed" at L180 must NOT be extracted as an error span.
	if strings.Contains(preview, "step 180:") {
		t.Fatalf("benign '0 errors' line should not be extracted as diagnostic:\n%s", preview)
	}
	// Real failure at L240-L241 MUST be extracted with ±2 context (L238..L243)!
	for _, want := range []string{
		"L238: line-238:",
		"L239: line-239:",
		"L240: --- FAIL: TestSessionCompactionReplay (0.08s)",
		"L241:     replay_test.go:92: error: expected KeepFrom=18, got 4",
		"L242: line-242:",
		"L243: line-243:",
	} {
		if !strings.Contains(preview, want) {
			t.Fatalf("preview missing extracted diagnostic/context %q:\n%s", want, preview)
		}
	}
	// Tail 25 lines (L476..L500) present.
	if !strings.Contains(preview, "line-476:") || !strings.Contains(preview, "line-500:") {
		t.Fatalf("expected tail 25 lines in preview:\n%s", preview)
	}
	// Exact saved-file footer present.
	wantFooter := fmt.Sprintf("[Full output saved to %s (500 lines, %d bytes) — use read/search on this file if more lines are needed]", spillPath, len(full))
	if !strings.HasSuffix(preview, wantFooter) {
		t.Fatalf("preview missing exact footer:\nwant suffix: %s\ngot:\n%s", wantFooter, preview)
	}
}

func TestArrivalSpillSingleGiantMinifiedLineAndSanitization(t *testing.T) {
	brainDir := t.TempDir()
	giant := `{"items":[` + strings.Repeat(`{"key":"🔥日本語value","ok":true},`, 1100) + `{"end":1}]}`
	if len(giant) <= ArrivalSpillThresholdBytes {
		t.Fatalf("giant payload must exceed 20KB, got %d", len(giant))
	}

	// Hostile call ID with path traversal characters must sanitize inside BrainDir.
	ctx := core.WithToolCallID(context.Background(), "../../outside/evil:call*id?99")
	res, ok := maybeSpillOutput(ctx, brainDir, giant)
	if !ok {
		t.Fatal("expected spill to succeed")
	}
	if filepath.Dir(res.Path) != filepath.Clean(brainDir) {
		t.Fatalf("spilled file escaped brainDir: %s (brain=%s)", res.Path, brainDir)
	}
	if len(res.Preview) > arrivalSpillMaxPreviewBytes || !utf8.ValidString(res.Preview) {
		t.Fatalf("invalid or oversized preview: len=%d utf8=%v", len(res.Preview), utf8.ValidString(res.Preview))
	}
	diskBytes, err := os.ReadFile(res.Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(diskBytes) != giant {
		t.Fatalf("spilled file is not byte-for-byte lossless (got %d bytes, want %d)", len(diskBytes), len(giant))
	}
}

func TestBashToolArrivalSpillLosslessAbove50KB(t *testing.T) {
	if currentShell().path == "" {
		SetShellOverride("synthetic-shell", "-c", true)
		t.Cleanup(ClearShellOverride)
	}

	// Build a >65KB multi-line payload so outputAccumulator crosses its 50KB
	// tempFile threshold AND arrival spill (>20KB) captures 100% of bytes!
	var expected strings.Builder
	for i := 1; i <= 900; i++ {
		if i == 420 {
			expected.WriteString("panic: runtime error: slice bounds out of range [9:4]\n")
		} else {
			fmt.Fprintf(&expected, "bash-row-%04d: %s\n", i, strings.Repeat("z", 64))
		}
	}
	fullExpected := expected.String()
	if len(fullExpected) <= 60*1024 {
		t.Fatalf("expected >60KB payload, got %d", len(fullExpected))
	}

	starter := func(_ context.Context, _ ExecSpec) (*Proc, error) {
		exited := make(chan struct{})
		close(exited)
		return &Proc{
			PID:    4242,
			Exited: exited,
			Wait:   func() error { return nil },
			Stop:   func() {},
			Pump: func(_ <-chan struct{}, consume func([]byte)) {
				// Feed in 8KB chunks to exercise chunk + tempFile streaming.
				raw := []byte(fullExpected)
				for off := 0; off < len(raw); off += 8192 {
					end := off + 8192
					if end > len(raw) {
						end = len(raw)
					}
					consume(raw[off:end])
				}
			},
			Cleanup: func(bool) {},
		}, nil
	}

	dir := t.TempDir()
	brainDir := t.TempDir()
	tool := &BashTool{
		CWD:      dir,
		Sandbox:  NewSandbox(dir),
		Starter:  starter,
		BrainDir: brainDir,
	}

	ctx := core.WithToolCallID(context.Background(), "call_bash_spill_1")
	res, err := tool.Execute(ctx, mustJSON(t, map[string]any{"command": "go test ./..."}), nil)
	if err != nil {
		t.Fatal(err)
	}

	wantPath := filepath.Join(brainDir, "tool-call_bash_spill_1.log")
	savedBytes, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatalf("expected spilled log at %s: %v", wantPath, err)
	}
	if string(savedBytes) != fullExpected {
		t.Fatalf("spilled bash file mismatch: got %d bytes, want %d bytes", len(savedBytes), len(fullExpected))
	}

	llmBody := envBody(t, res)
	if len(llmBody) > arrivalSpillMaxPreviewBytes {
		t.Fatalf("LLM preview exceeded 6KB: %d bytes", len(llmBody))
	}
	for _, needle := range []string{
		"bash-row-0001:",
		"panic: runtime error: slice bounds out of range",
		"bash-row-0900:",
		wantPath,
	} {
		if !strings.Contains(llmBody, needle) {
			t.Fatalf("bash preview missing %q:\n%s", needle, llmBody)
		}
	}

	details := res.Details.(map[string]any)
	if details["output"] != fullExpected {
		t.Fatalf("UI Details[output] lost full lossless text")
	}
	if details["full_output_path"] != wantPath {
		t.Fatalf("UI Details[full_output_path] = %v, want %s", details["full_output_path"], wantPath)
	}
}

func TestExecScriptToolArrivalSpill(t *testing.T) {
	dir := t.TempDir()
	brainDir := t.TempDir()
	tool := &ExecScriptTool{
		CWD:      dir,
		Sandbox:  NewSandbox(dir),
		BrainDir: brainDir,
	}

	ctx := core.WithToolCallID(context.Background(), "call_js_spill_7")
	code := `
		const pad = "q".repeat(55);
		for (let i = 1; i <= 450; i++) {
			if (i === 210) {
				console.log("ERROR: schema checksum mismatch on migration 14");
			} else {
				console.log("js-line-" + String(i).padStart(4, "0") + " " + pad);
			}
		}
	`
	res, err := tool.Execute(ctx, mustJSON(t, map[string]any{"code": code}), nil)
	if err != nil {
		t.Fatal(err)
	}

	wantPath := filepath.Join(brainDir, "tool-call_js_spill_7.log")
	savedBytes, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatalf("expected spilled exec_script log at %s: %v", wantPath, err)
	}
	if len(savedBytes) <= ArrivalSpillThresholdBytes {
		t.Fatalf("expected >20KB saved output, got %d bytes", len(savedBytes))
	}
	if !strings.Contains(string(savedBytes), "js-line-0001") || !strings.Contains(string(savedBytes), "js-line-0450") {
		t.Fatalf("saved exec_script log incomplete")
	}

	llmBody := envBody(t, res)
	if len(llmBody) > arrivalSpillMaxPreviewBytes {
		t.Fatalf("exec_script preview exceeded 6KB: %d bytes", len(llmBody))
	}
	if !strings.Contains(llmBody, "ERROR: schema checksum mismatch") || !strings.Contains(llmBody, wantPath) {
		t.Fatalf("exec_script preview missing extracted error or path:\n%s", llmBody)
	}

	det := res.Details.(map[string]any)
	if det["output"] != string(savedBytes) {
		t.Fatalf("UI Details[output] must retain full lossless output")
	}
}

func TestFetchURLToolArrivalSpillAndReadToolExemption(t *testing.T) {
	var docBuilder strings.Builder
	for i := 1; i <= 420; i++ {
		if i == 200 {
			docBuilder.WriteString("FATAL: upstream OpenAPI contract validation failed\n")
		} else {
			fmt.Fprintf(&docBuilder, "doc-line-%04d: %s\n", i, strings.Repeat("m", 56))
		}
	}
	fullDoc := strings.TrimSpace(docBuilder.String())

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(fullDoc))
	}))
	defer srv.Close()

	dir := t.TempDir()
	brainDir := t.TempDir()
	fetchTool := &FetchURLTool{
		CWD:               dir,
		Sandbox:           NewSandbox(dir),
		Client:            srv.Client(),
		TestAllowLoopback: true,
		BrainDir:          brainDir,
	}

	ctx := core.WithToolCallID(context.Background(), "call_fetch_spill_9")
	res, err := fetchTool.Execute(ctx, mustJSON(t, map[string]any{"url": srv.URL + "/spec.txt"}), nil)
	if err != nil {
		t.Fatal(err)
	}

	wantPath := filepath.Join(brainDir, "tool-call_fetch_spill_9.log")
	savedBytes, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatalf("expected spilled fetch_url log at %s: %v", wantPath, err)
	}
	if string(savedBytes) != fullDoc {
		t.Fatalf("fetch_url spilled file mismatch (got %d bytes, want %d)", len(savedBytes), len(fullDoc))
	}
	preview := envBody(t, res)
	if len(preview) > arrivalSpillMaxPreviewBytes || !strings.Contains(preview, "FATAL: upstream OpenAPI") || !strings.Contains(preview, wantPath) {
		t.Fatalf("fetch_url preview invalid:\n%s", preview)
	}
	det := res.Details.(map[string]any)
	if det["content"] != fullDoc {
		t.Fatalf("fetch_url UI Details[content] lost full lossless body")
	}

	// ReadTool MUST NEVER apply arrival spill even on >20KB files with BrainDir set!
	readBrain := t.TempDir()
	bigFile := filepath.Join(dir, "big.go")
	if err := os.WriteFile(bigFile, []byte(fullDoc+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	_ = &mu
	readTool := &ReadTool{
		CWD:      dir,
		Sandbox:  NewSandbox(dir),
		BrainDir: readBrain,
	}
	readRes, err := readTool.Execute(core.WithToolCallID(context.Background(), "call_read_1"), mustJSON(t, map[string]any{
		"path": "big.go",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(readBrain)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("ReadTool must NEVER spill to BrainDir, found %d files", len(entries))
	}
	if got := envBody(t, readRes); strings.Contains(got, "[Full output saved to") || len(got) <= ArrivalSpillThresholdBytes {
		t.Fatalf("ReadTool unexpectedly truncated/spilled output (len=%d)", len(got))
	}
}
