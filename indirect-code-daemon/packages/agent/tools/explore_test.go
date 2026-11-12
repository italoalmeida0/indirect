package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"indirect/indirect-code-daemon/packages/provider"
)

type mockExploreClient struct {
	mu       sync.Mutex
	requests []provider.Request
	handler  func(callIdx int, req provider.Request) ([]provider.Event, error)
}

func (m *mockExploreClient) Name() string { return "mock-explore" }

func (m *mockExploreClient) Stream(_ context.Context, req provider.Request) (<-chan provider.Event, error) {
	m.mu.Lock()
	idx := len(m.requests)
	m.requests = append(m.requests, req)
	m.mu.Unlock()

	evs, err := m.handler(idx, req)
	if err != nil {
		return nil, err
	}
	ch := make(chan provider.Event, len(evs)+1)
	for _, ev := range evs {
		ch <- ev
	}
	close(ch)
	return ch, nil
}

func streamToolCallTurn(callID, toolName string, args any, usage provider.Usage) []provider.Event {
	rawArgs, _ := json.Marshal(args)
	msg := provider.Message{
		Role: provider.RoleAssistant,
		Content: []provider.Content{
			provider.ToolCallBlock{
				ID:        callID,
				Name:      toolName,
				Arguments: rawArgs,
			},
		},
	}
	return []provider.Event{
		provider.EventStart{},
		provider.EventToolStart{ID: callID, Name: toolName},
		provider.EventToolArgs{ID: callID, Delta: string(rawArgs)},
		provider.EventToolEnd{ID: callID},
		provider.EventUsage{Usage: usage},
		provider.EventDone{Stop: provider.StopToolUse, Message: msg},
	}
}

func streamFinalTextTurn(text string, usage provider.Usage) []provider.Event {
	msg := provider.Message{
		Role: provider.RoleAssistant,
		Content: []provider.Content{
			provider.TextBlock{Text: text},
		},
	}
	return []provider.Event{
		provider.EventStart{},
		provider.EventTextDelta{Delta: text},
		provider.EventUsage{Usage: usage},
		provider.EventDone{Stop: provider.StopEnd, Message: msg},
	}
}

func TestExploreToolReadOnlyToolsetUsageForwardingAndSandboxIsolation(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pkg", "router.go"), []byte("package pkg\n\nfunc RouteRequest() string { return \"ok\" }\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	parentSandbox := NewSandbox(dir)
	parentSandbox.Lock()
	if parentSandbox.ProjectReadOnly() {
		t.Fatal("precondition: parent sandbox starts writable")
	}

	histSource := func() SessionHistorySnapshot {
		return SessionHistorySnapshot{
			Messages: []provider.Message{
				{
					Role:    provider.RoleUser,
					Content: []provider.Content{provider.TextBlock{Text: "Earlier decision: keep RouteRequest stateless"}},
				},
			},
			KeepFrom: 1,
			Blocks: []SessionHistoryBlock{
				{ID: "b1", Tier: 1, StartIdx: 0, EndIdx: 1, Summary: "RouteRequest stateless invariant"},
			},
		}
	}

	client := &mockExploreClient{
		handler: func(callIdx int, req provider.Request) ([]provider.Event, error) {
			switch callIdx {
			case 0:
				return streamToolCallTurn("c1", "glob", map[string]any{"pattern": "**/*.go"}, provider.Usage{
					InputTokens:     110,
					OutputTokens:    25,
					CacheReadTokens: 40,
				}), nil
			case 1:
				return streamToolCallTurn("c2", "read", map[string]any{"path": "pkg/router.go"}, provider.Usage{
					InputTokens:  180,
					OutputTokens: 30,
				}), nil
			case 2:
				return streamToolCallTurn("c3", "session_history", map[string]any{"action": "search", "query": "RouteRequest"}, provider.Usage{
					InputTokens:  210,
					OutputTokens: 35,
				}), nil
			default:
				return streamFinalTextTurn("Synthesis: `pkg/router.go:3` defines `RouteRequest()`, which must remain stateless per block `b1`.", provider.Usage{
					InputTokens:     260,
					OutputTokens:    55,
					ReasoningTokens: 15,
				}), nil
			}
		},
	}

	var usageEvents []provider.Usage
	var totalReported provider.Usage
	explore := &ExploreTool{
		Client:        client,
		Model:         "test-explore-model",
		CWD:           dir,
		Sandbox:       parentSandbox,
		HistorySource: histSource,
		OnUsage: func(u provider.Usage) {
			usageEvents = append(usageEvents, u)
			totalReported = totalReported.Add(u)
		},
	}

	var progressSteps []string
	res, err := explore.Execute(context.Background(), mustJSON(t, map[string]any{
		"task":        "Find RouteRequest implementation and any prior architectural constraints.",
		"focus_paths": []string{"pkg/router.go"},
	}), func(step string) {
		progressSteps = append(progressSteps, step)
	})
	if err != nil {
		t.Fatal(err)
	}

	// 1. Parent sandbox MUST NOT have been mutated to read-only!
	if parentSandbox.ProjectReadOnly() {
		t.Fatal("ExploreTool mutated parent Sandbox.ProjectReadOnly()")
	}

	// 2. Verify exposed tool specs are strictly read-only (no write/edit/bash/exec_script/explore).
	if len(client.requests) != 4 {
		t.Fatalf("expected 4 model turns, got %d", len(client.requests))
	}
	var specNames []string
	for _, s := range client.requests[0].Tools {
		specNames = append(specNames, s.Name)
	}
	sort.Strings(specNames)
	wantSpecs := []string{"glob", "inspect", "read", "search", "session_history"}
	if strings.Join(specNames, ",") != strings.Join(wantSpecs, ",") {
		t.Fatalf("subagent tools = %v, want exact read-only allowlist %v", specNames, wantSpecs)
	}

	// 3. Verify focus_paths reached the initial subagent user message.
	firstPrompt := extractRawMessageText(client.requests[0].Messages[0])
	if !strings.Contains(firstPrompt, "pkg/router.go") {
		t.Fatalf("expected focus_paths in subagent prompt, got %q", firstPrompt)
	}

	// 4. Verify OnUsage forwarded incremental deltas (never cumulative double-counts!).
	if len(usageEvents) != 4 {
		t.Fatalf("expected 4 incremental OnUsage callbacks, got %d", len(usageEvents))
	}
	wantInput := 110 + 180 + 210 + 260
	wantOutput := 25 + 30 + 35 + 55
	if totalReported.InputTokens != wantInput || totalReported.OutputTokens != wantOutput || totalReported.CacheReadTokens != 40 || totalReported.ReasoningTokens != 15 {
		t.Fatalf("usage mismatch: got %+v, want input=%d output=%d cacheRead=40 reasoning=15",
			totalReported, wantInput, wantOutput)
	}

	// 5. Verify live progress steps, durable Attrs, Details, and returned synthesis text.
	wantProgress := []string{
		"step 1 · glob **/*.go",
		"step 2 · read pkg/router.go",
		"step 3 · session_history RouteRequest",
	}
	if strings.Join(progressSteps, "|") != strings.Join(wantProgress, "|") {
		t.Fatalf("progressSteps = %v, want %v", progressSteps, wantProgress)
	}
	if envAttr(res, "turns") != "4" || envAttr(res, "tool_calls") != "3" ||
		envAttr(res, "in_tokens") != strconv.Itoa(wantInput) ||
		envAttr(res, "out_tokens") != strconv.Itoa(wantOutput) ||
		envAttr(res, "duration") == "" || envAttr(res, "turn_cap_reached") != "" {
		t.Fatalf("unexpected explore Attrs: %+v", res.Attrs)
	}
	det, ok := res.Details.(map[string]any)
	if !ok {
		t.Fatalf("expected Details map, got %T", res.Details)
	}
	if det["turns"] != 4 || det["tool_calls"] != 3 ||
		det["input_tokens"] != wantInput || det["output_tokens"] != wantOutput ||
		det["turn_cap_reached"] != false {
		t.Fatalf("unexpected explore Details: %#v", det)
	}
	if durMs, ok := det["duration_ms"].(int64); !ok || durMs < 0 {
		t.Fatalf("expected int64 duration_ms >= 0, got %#v (%T)", det["duration_ms"], det["duration_ms"])
	}
	got := envBody(t, res)
	if !strings.Contains(got, "pkg/router.go:3") || !strings.Contains(got, "RouteRequest()") {
		t.Fatalf("unexpected synthesis: %q", got)
	}
}

func TestExploreToolRejectsMutatingOrRecursiveToolCalls(t *testing.T) {
	dir := t.TempDir()
	forbidden := []string{"write", "edit", "bash", "exec_script", "explore"}

	var observedErrors []string
	client := &mockExploreClient{
		handler: func(callIdx int, req provider.Request) ([]provider.Event, error) {
			if callIdx > 0 {
				lastMsg := req.Messages[len(req.Messages)-1]
				observedErrors = append(observedErrors, fmt.Sprintf("%+v", lastMsg.Content))
			}
			if callIdx < len(forbidden) {
				name := forbidden[callIdx]
				return streamToolCallTurn(fmt.Sprintf("bad_%d", callIdx), name, map[string]any{
					"path":    "pwned.txt",
					"content": "nope",
					"command": "touch pwned.txt",
					"code":    "console.log(1)",
					"task":    "recurse",
				}, provider.Usage{InputTokens: 10, OutputTokens: 5}), nil
			}
			return streamFinalTextTurn("Confirmed read-only boundary.", provider.Usage{InputTokens: 10, OutputTokens: 5}), nil
		},
	}

	explore := &ExploreTool{
		Client:  client,
		Model:   "test-model",
		CWD:     dir,
		Sandbox: NewSandbox(dir),
	}
	res, err := explore.Execute(context.Background(), mustJSON(t, map[string]any{
		"task": "Verify forbidden tools cannot execute.",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(observedErrors) != len(forbidden) {
		t.Fatalf("expected %d rejected tool results, got %d", len(forbidden), len(observedErrors))
	}
	for i, obs := range observedErrors {
		if !strings.Contains(obs, "unknown tool") && !strings.Contains(obs, "not permitted") {
			t.Fatalf("forbidden tool %q was not rejected cleanly: %s", forbidden[i], obs)
		}
	}
	if _, statErr := os.Stat(filepath.Join(dir, "pwned.txt")); !os.IsNotExist(statErr) {
		t.Fatalf("forbidden write created pwned.txt!")
	}
	if got := envBody(t, res); !strings.Contains(got, "Confirmed read-only boundary.") {
		t.Fatalf("unexpected result: %q", got)
	}
}

func TestExploreToolEnforcesMaxTurns12AndOutputCap12KB(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte("package a\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 1. Runaway tool-calling model is strictly stopped at MaxTurns=12.
	runawayClient := &mockExploreClient{
		handler: func(callIdx int, _ provider.Request) ([]provider.Event, error) {
			return streamToolCallTurn(
				fmt.Sprintf("loop_%d", callIdx),
				"glob",
				map[string]any{"pattern": fmt.Sprintf("*.go-%d", callIdx)},
				provider.Usage{InputTokens: 20, OutputTokens: 10},
			), nil
		},
	}
	exploreCap := &ExploreTool{
		Client:  runawayClient,
		Model:   "test-model",
		CWD:     dir,
		Sandbox: NewSandbox(dir),
	}
	resCap, err := exploreCap.Execute(context.Background(), mustJSON(t, map[string]any{
		"task": "Keep searching forever",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(runawayClient.requests) != ExploreDefaultMaxTurns {
		t.Fatalf("expected strict %d max turns, got %d LLM requests", ExploreDefaultMaxTurns, len(runawayClient.requests))
	}
	if envAttr(resCap, "turn_cap_reached") != "true" {
		t.Fatalf("expected turn_cap_reached=true, got %q", envAttr(resCap, "turn_cap_reached"))
	}
	detCap := resCap.Details.(map[string]any)
	if detCap["turn_cap_reached"] != true || detCap["turns"] != ExploreDefaultMaxTurns || detCap["tool_calls"] != ExploreDefaultMaxTurns {
		t.Fatalf("expected Details turn_cap_reached=true and turns/tool_calls=%d, got %#v", ExploreDefaultMaxTurns, detCap)
	}

	// 2. Oversized >25KB multi-byte UTF-8 synthesis is cleanly capped to <= 12KB.
	var overBuilder strings.Builder
	overBuilder.WriteString("### Findings\n")
	for i := 1; i <= 500; i++ {
		fmt.Fprintf(&overBuilder, "- finding #%04d: 🔥日本語 symbolRef_%d defined at pkg/mod_%02d/handler.go:%d\n", i, i*7, i%23, i*3)
	}
	oversized := overBuilder.String()
	verboseClient := &mockExploreClient{
		handler: func(_ int, _ provider.Request) ([]provider.Event, error) {
			return streamFinalTextTurn(oversized, provider.Usage{InputTokens: 50, OutputTokens: 500}), nil
		},
	}
	exploreVerbose := &ExploreTool{
		Client:  verboseClient,
		Model:   "test-model",
		CWD:     dir,
		Sandbox: NewSandbox(dir),
	}
	resVerbose, err := exploreVerbose.Execute(context.Background(), mustJSON(t, map[string]any{
		"task": "Summarize everything verbosely",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	gotBody := envBody(t, resVerbose)
	if len(gotBody) > ExploreMaxOutputBytes {
		t.Fatalf("explore synthesis exceeded 12KB cap: got %d bytes (max %d)", len(gotBody), ExploreMaxOutputBytes)
	}
	if !utf8.ValidString(gotBody) {
		t.Fatal("truncated explore synthesis broke UTF-8 rune boundary")
	}
	if !strings.HasSuffix(gotBody, "[... explore synthesis truncated to 12KB]") {
		t.Fatalf("expected clean truncation marker at end of capped synthesis")
	}
}

func TestExploreProgressHintUTF8BoundsAndDurationFormatting(t *testing.T) {
	// 1. Progress formatting: target extraction, no-hint fallback, newline/whitespace collapse, and <=72-rune UTF-8 cap.
	if got := formatExploreStepProgress(1, "inspect", json.RawMessage(`{}`)); got != "step 1 · inspect" {
		t.Fatalf("no-hint progress = %q, want %q", got, "step 1 · inspect")
	}
	if got := formatExploreStepProgress(2, "session_history", json.RawMessage(`{"action":"recall","block_id":"b4"}`)); got != "step 2 · session_history b4" {
		t.Fatalf("block_id progress = %q, want %q", got, "step 2 · session_history b4")
	}
	longUTF8Query := "🔥日本語\n\t  " + strings.Repeat("超長い識別子🚀_", 14)
	rawArgs, _ := json.Marshal(map[string]any{"pattern": longUTF8Query})
	capped := formatExploreStepProgress(3, "search", rawArgs)
	if !utf8.ValidString(capped) {
		t.Fatalf("capped progress broke UTF-8: %q", capped)
	}
	if rc := utf8.RuneCountInString(capped); rc > exploreProgressMaxRunes {
		t.Fatalf("progress rune count = %d, want <= %d (%q)", rc, exploreProgressMaxRunes, capped)
	}
	if strings.ContainsAny(capped, "\n\r\t") || strings.Contains(capped, "  ") {
		t.Fatalf("progress must be single-line whitespace-collapsed: %q", capped)
	}
	if !strings.HasPrefix(capped, "step 3 · search 🔥日本語 ") || !strings.HasSuffix(capped, "…") {
		t.Fatalf("unexpected capped progress string: %q", capped)
	}

	// 2. Zero-token usage omits in_tokens / out_tokens attrs cleanly.
	dir := t.TempDir()
	zeroUsageClient := &mockExploreClient{
		handler: func(_ int, _ provider.Request) ([]provider.Event, error) {
			return streamFinalTextTurn("Done.", provider.Usage{}), nil
		},
	}
	resZero, err := (&ExploreTool{
		Client:  zeroUsageClient,
		Model:   "test-model",
		CWD:     dir,
		Sandbox: NewSandbox(dir),
	}).Execute(context.Background(), mustJSON(t, map[string]any{"task": "Quick check"}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if envAttr(resZero, "in_tokens") != "" || envAttr(resZero, "out_tokens") != "" {
		t.Fatalf("expected zero-token attrs omitted, got %+v", resZero.Attrs)
	}

	// 3. Human duration formatting conventions.
	durCases := []struct {
		in   time.Duration
		want string
	}{
		{0, "0ms"},
		{450 * time.Millisecond, "450ms"},
		{2400 * time.Millisecond, "2.4s"},
		{9960 * time.Millisecond, "10s"},
		{14 * time.Second, "14s"},
		{72 * time.Second, "1m 12s"},
		{120 * time.Second, "2m"},
		{3903 * time.Second, "1h 5m 3s"},
	}
	for _, tc := range durCases {
		if got := formatExploreDuration(tc.in); got != tc.want {
			t.Fatalf("formatExploreDuration(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
