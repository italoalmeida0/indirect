package tools

import (
	"context"
	"encoding/json"
	"testing"

	"indirect/indirect-code-daemon/packages/core"
)

type fakeBgCheckHost struct {
	res BgCheckResult
	err error
}

func (h fakeBgCheckHost) ReadBackgroundTask(callerSessionID, jobID string, offset, limit int) (BgCheckResult, error) {
	return h.res, h.err
}

func bgCheck(t *testing.T, tool *BgCheckTool, args string) core.ToolResult {
	t.Helper()
	res, err := tool.Execute(context.Background(), json.RawMessage(args), nil)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestBgCheckTailDefault(t *testing.T) {
	tool := &BgCheckTool{Host: fakeBgCheckHost{res: BgCheckResult{
		Found: true, Kind: "bash", Label: "sleep 15", Status: "running",
		Text: "out1\nout2", From: 91, To: 92, Total: 92,
	}}, SessionID: "s"}
	res := bgCheck(t, tool, `{"job_id":"bg_1"}`)
	if got := envAttr(res, "status"); got != "running" {
		t.Fatalf("status attr = %q", got)
	}
	if got := envAttr(res, "command"); got != "sleep 15" {
		t.Fatalf("command attr = %q", got)
	}
	if got := envAttr(res, "page"); got != "91-92/92" {
		t.Fatalf("page attr = %q", got)
	}
	if got := envBody(t, res); got != "91:out1\n92:out2" {
		t.Fatalf("body = %q", got)
	}
}

func TestBgCheckTruncationAndTerminal(t *testing.T) {
	tool := &BgCheckTool{Host: fakeBgCheckHost{res: BgCheckResult{
		Found: true, Kind: "exec_script", Label: "console.log('train')", Status: "done", ExitCode: 0,
		Text: "last", From: 1000, To: 1000, Total: 1000, Dropped: 999, Truncated: true,
	}}, SessionID: "s"}
	res := bgCheck(t, tool, `{"job_id":"bg_2","offset":1000,"limit":10}`)
	if got := envAttr(res, "dropped"); got != "999" {
		t.Fatalf("dropped attr = %q", got)
	}
	if got := envAttr(res, "exit"); got != "0" {
		t.Fatalf("exit attr = %q", got)
	}
	if got := envAttr(res, "status"); got != "done" {
		t.Fatalf("status attr = %q", got)
	}
	if got := envBody(t, res); got != "1000:last" {
		t.Fatalf("body = %q", got)
	}
}

func TestBgCheckNoOutputYet(t *testing.T) {
	tool := &BgCheckTool{Host: fakeBgCheckHost{res: BgCheckResult{
		Found: true, Kind: "bash", Label: "sleep 5", Status: "running",
	}}, SessionID: "s"}
	res := bgCheck(t, tool, `{"job_id":"bg_3"}`)
	if got := envAttr(res, "info"); got != "No output yet." {
		t.Fatalf("info attr = %q", got)
	}
	if got := envBody(t, res); got != "" {
		t.Fatalf("body must be empty, got %q", got)
	}
}

func TestBgCheckRequiresJobID(t *testing.T) {
	tool := &BgCheckTool{Host: fakeBgCheckHost{}, SessionID: "s"}
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{}`), nil); err == nil {
		t.Fatal("empty job_id must fail")
	}
	toolNoHost := &BgCheckTool{SessionID: "s"}
	if _, err := toolNoHost.Execute(context.Background(), json.RawMessage(`{"job_id":"bg_1"}`), nil); err == nil {
		t.Fatal("nil host must fail")
	}
	toolUnknown := &BgCheckTool{Host: fakeBgCheckHost{res: BgCheckResult{Found: false}}, SessionID: "s"}
	if _, err := toolUnknown.Execute(context.Background(), json.RawMessage(`{"job_id":"bg_nope"}`), nil); err == nil {
		t.Fatal("unknown task must fail")
	}
}

func TestBgCheckSummaryAttrDistinctFromCommand(t *testing.T) {
	tool := &BgCheckTool{Host: fakeBgCheckHost{res: BgCheckResult{
		Found: true, Kind: "bash", Label: "Unit test execution", Command: "bun test ./test/indirect-code-ui.test.ts",
		Status: "running", Text: "pass", From: 1, To: 1, Total: 1,
	}}, SessionID: "s"}
	res := bgCheck(t, tool, `{"job_id":"bg_1"}`)
	if got := envAttr(res, "summary"); got != "Unit test execution" {
		t.Fatalf("summary attr = %q, want %q", got, "Unit test execution")
	}
	if got := envAttr(res, "command"); got != "bun test ./test/indirect-code-ui.test.ts" {
		t.Fatalf("command attr = %q", got)
	}

	// Legacy task where Label == Command must omit summary attr.
	legacy := &BgCheckTool{Host: fakeBgCheckHost{res: BgCheckResult{
		Found: true, Kind: "bash", Label: "sleep 15", Command: "sleep 15",
		Status: "running", Text: "ok", From: 1, To: 1, Total: 1,
	}}, SessionID: "s"}
	legacyRes := bgCheck(t, legacy, `{"job_id":"bg_2"}`)
	if got := envAttr(legacyRes, "summary"); got != "" {
		t.Fatalf("legacy identical label/command should omit summary attr, got %q", got)
	}
}

type fakeBgCancelHost struct {
	out BgCancelOutcome
	err error
}

func (h fakeBgCancelHost) CancelBackgroundJob(callerSessionID, jobID string) (BgCancelOutcome, error) {
	return h.out, h.err
}

func TestBgCancelEmitsSummaryAttrAndDetail(t *testing.T) {
	tool := &BgCancelTool{
		Host: fakeBgCancelHost{out: BgCancelOutcome{
			OK:     true,
			Status: "cancelled",
			Kind:   "bash",
			Label:  "Dev server startup",
			Notice: "Background task Dev server startup canceled.",
		}},
		SessionID: "s",
	}
	res, err := tool.Execute(context.Background(), json.RawMessage(`{"job_id":"bg_1"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := envAttr(res, "summary"); got != "Dev server startup" {
		t.Fatalf("summary attr = %q, want %q", got, "Dev server startup")
	}
	resDetails, _ := res.Details.(map[string]any)
	if got, _ := resDetails["summary"].(string); got != "Dev server startup" {
		t.Fatalf("details[summary] = %q, want %q", got, "Dev server startup")
	}

	// Already-finished job still carries its summary for UI header/body rendering.
	doneTool := &BgCancelTool{
		Host: fakeBgCancelHost{out: BgCancelOutcome{
			OK:     false,
			Status: "done",
			Kind:   "exec_script",
			Label:  "Dataset transform",
			Notice: "Background task Dataset transform already finished.",
		}},
		SessionID: "s",
	}
	doneRes, err := doneTool.Execute(context.Background(), json.RawMessage(`{"job_id":"bg_2"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := envAttr(doneRes, "summary"); got != "Dataset transform" {
		t.Fatalf("done summary attr = %q, want %q", got, "Dataset transform")
	}
	doneDetails, _ := doneRes.Details.(map[string]any)
	if got, _ := doneDetails["summary"].(string); got != "Dataset transform" {
		t.Fatalf("done details[summary] = %q, want %q", got, "Dataset transform")
	}

	// Empty label omits summary from both Attrs and Details.
	noLabelTool := &BgCancelTool{
		Host: fakeBgCancelHost{out: BgCancelOutcome{OK: true, Status: "cancelled", Kind: "bash"}},
		SessionID: "s",
	}
	noLabelRes, err := noLabelTool.Execute(context.Background(), json.RawMessage(`{"job_id":"bg_3"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := envAttr(noLabelRes, "summary"); got != "" {
		t.Fatalf("empty label must omit summary attr, got %q", got)
	}
	noLabelDetails, _ := noLabelRes.Details.(map[string]any)
	if _, exists := noLabelDetails["summary"]; exists {
		t.Fatalf("empty label must omit details[summary], got %#v", noLabelDetails["summary"])
	}
}
