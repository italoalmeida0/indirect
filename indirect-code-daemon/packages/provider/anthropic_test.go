package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAnthropicBuildRequest(t *testing.T) {
	c := NewGatewayAnthropic("gw_key", "http://gw/anthropic/v1", Model{ID: "m"}).(*anthropicClient)
	wire, err := c.buildRequest(Request{
		Model:     "m",
		System:    "sys",
		MaxTokens: 512,
		Messages: []Message{
			{Role: RoleUser, Content: []Content{TextBlock{Text: "hi"}}},
			{Role: RoleAssistant, Content: []Content{
				TextBlock{Text: "calling"},
				ToolCallBlock{ID: "tu1", Name: "read", Arguments: json.RawMessage(`{"path":"a"}`)},
			}},
			{Role: RoleTool, Content: []Content{
				ToolResultBlock{CallID: "tu1", Content: []Content{TextBlock{Text: "file!"}}},
			}},
		},
		Tools: []Tool{{Name: "read", Description: "read", Schema: json.RawMessage(`{"type":"object"}`)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !wire.Stream {
		t.Fatal("stream must be true")
	}
	if wire.MaxTokens != 512 {
		t.Fatalf("max_tokens=%d", wire.MaxTokens)
	}
	sysBlocks, ok := wire.System.([]anthSystemBlock)
	if !ok || len(sysBlocks) != 1 || sysBlocks[0].Text != "sys" {
		t.Fatalf("system=%+v", wire.System)
	}
	if sysBlocks[0].CacheControl == nil || sysBlocks[0].CacheControl.Type != "ephemeral" {
		t.Fatalf("system cache_control missing: %+v", sysBlocks[0].CacheControl)
	}
	if len(wire.Messages) != 3 {
		t.Fatalf("messages=%d want 3", len(wire.Messages))
	}
	asst, _ := json.Marshal(wire.Messages[1].Content)
	if !strings.Contains(string(asst), `"tool_use"`) || !strings.Contains(string(asst), `"tu1"`) {
		t.Fatalf("assistant blocks=%s", asst)
	}
	tool, _ := json.Marshal(wire.Messages[2].Content)
	if !strings.Contains(string(tool), `"tool_result"`) {
		t.Fatalf("tool blocks=%s", tool)
	}
	if !strings.Contains(string(tool), `"cache_control"`) {
		t.Fatalf("tool result message missing cache_control: %s", tool)
	}
	if len(wire.Tools) != 1 || wire.Tools[0].Name != "read" {
		t.Fatalf("tools=%+v", wire.Tools)
	}
	if wire.Tools[0].CacheControl == nil || wire.Tools[0].CacheControl.Type != "ephemeral" {
		t.Fatalf("tools[0] cache_control missing: %+v", wire.Tools[0].CacheControl)
	}
}

// The selected session effort must reach the gateway on the wire:
// exact adaptive tier in output_config plus a manual thinking budget.
// Regression: buildRequest used to drop req.Reasoning entirely, so the
// gateway defaulted every reasoning model to "low".
func TestAnthropicBuildRequestReasoningEffort(t *testing.T) {
	glm := Model{ID: "hf:zai-org/GLM-5.3-Flash", Reasoning: true,
		ReasoningLevelMap: map[string]string{"low": "low", "high": "high", "max": "max"},
		ContextWindow:     524288, MaxOutput: 65536}
	build := func(c *anthropicClient, effort string, maxTok int) *anthRequest {
		wire, err := c.buildRequest(Request{Model: "m", Reasoning: effort, MaxTokens: maxTok,
			Messages: []Message{{Role: RoleUser, Content: []Content{TextBlock{Text: "hi"}}}}})
		if err != nil {
			t.Fatal(err)
		}
		return wire
	}

	c := NewGatewayAnthropic("gw_key", "http://gw/anthropic/v1", glm).(*anthropicClient)
	wire := build(c, "max", 64000)
	if wire.OutputConfig == nil || wire.OutputConfig.Effort != "max" {
		t.Fatalf("max effort not on wire: %+v", wire.OutputConfig)
	}
	if wire.Thinking == nil || wire.Thinking.Type != "enabled" || wire.Thinking.BudgetTokens != 32768 {
		t.Fatalf("max thinking budget wrong: %+v", wire.Thinking)
	}
	body, _ := json.Marshal(wire)
	if !strings.Contains(string(body), `"output_config":{"effort":"max"}`) {
		t.Fatalf("serialized request missing effort: %s", body)
	}

	// A model that doesn't advertise max clamps to its nearest tier.
	generic := NewGatewayAnthropic("gw_key", "http://gw/anthropic/v1", Model{ID: "m", Reasoning: true}).(*anthropicClient)
	if got := build(generic, "max", 64000).OutputConfig.Effort; got != "high" {
		t.Fatalf("generic max clamp = %q, want high", got)
	}

	// Explicit off disables thinking and sends no effort tier, so the
	// gateway cannot substitute its own default.
	off := build(c, "none", 64000)
	if off.OutputConfig != nil {
		t.Fatalf("off must not send output_config: %+v", off.OutputConfig)
	}
	if off.Thinking == nil || off.Thinking.Type != "disabled" {
		t.Fatalf("off must disable thinking: %+v", off.Thinking)
	}

	// Manual budget always stays strictly below max_tokens.
	small := build(c, "low", 1500)
	if small.Thinking == nil || small.Thinking.BudgetTokens >= 1500 {
		t.Fatalf("budget must clamp below max_tokens: %+v", small.Thinking)
	}
	if small.OutputConfig == nil || small.OutputConfig.Effort != "low" {
		t.Fatalf("low effort not on wire: %+v", small.OutputConfig)
	}
}

func TestAnthropicHeadersAndPath(t *testing.T) {
	var path, key, ver string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, key, ver = r.URL.Path, r.Header.Get("x-api-key"), r.Header.Get("anthropic-version")
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("event: message_stop\ndata: {}\n\n"))
	}))
	defer srv.Close()

	c := NewGatewayAnthropic("gw_secret", srv.URL, Model{ID: "m"})
	evs, err := c.Stream(context.Background(), Request{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	for range evs {
	}
	if path != "/messages" {
		t.Fatalf("path=%q", path)
	}
	if key != "gw_secret" {
		t.Fatalf("x-api-key=%q", key)
	}
	if ver == "" {
		t.Fatal("anthropic-version missing")
	}
	if c.Name() != "anthropic" {
		t.Fatalf("name=%q", c.Name())
	}
}

func TestAnthropicStreamHappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		write := func(s string) {
			_, _ = w.Write([]byte(s))
			if fl != nil {
				fl.Flush()
			}
		}
		write("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":12,\"cache_read_input_tokens\":4,\"cache_creation_input_tokens\":2}}}\n\n")
		write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
		write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hel\"}}\n\n")
		write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\n")
		write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu1\",\"name\":\"read\"}}\n\n")
		write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"a\\\"}\"}}\n\n")
		write("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":9}}\n\n")
		write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer srv.Close()

	c := NewAnthropic("x", srv.URL)
	evs, err := c.Stream(context.Background(), Request{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	var text string
	var starts, ends int
	var done EventDone
	var usage Usage
	for ev := range evs {
		switch e := ev.(type) {
		case EventTextDelta:
			text += e.Delta
		case EventToolStart:
			starts++
			if e.ID != "tu1" || e.Name != "read" {
				t.Fatalf("tool start=%+v", e)
			}
		case EventToolEnd:
			ends++
		case EventUsage:
			usage = e.Usage
		case EventDone:
			done = e
		}
	}
	if text != "hello" {
		t.Fatalf("text=%q", text)
	}
	if starts != 1 || ends != 1 {
		t.Fatalf("starts=%d ends=%d", starts, ends)
	}
	if done.Stop != StopToolUse {
		t.Fatalf("stop=%v", done.Stop)
	}
	if len(done.Message.Content) != 2 {
		t.Fatalf("content blocks=%d", len(done.Message.Content))
	}
	if tc, ok := done.Message.Content[1].(ToolCallBlock); !ok || tc.ID != "tu1" || string(tc.Arguments) != `{"path":"a"}` {
		t.Fatalf("tool call=%+v", done.Message.Content[1])
	}
	if usage.InputTokens != 12 || usage.OutputTokens != 9 || usage.CacheReadTokens != 4 || usage.CacheWriteTokens != 2 {
		t.Fatalf("usage=%+v", usage)
	}
}

// Regression: the gateway emits message_stop, then a duplicate
// message_delta/message_stop retry pair, and finally the authoritative
// `: x-gateway-usage` tail comment. Usage must be the gateway figures
// (not zero), and the first stop reason must win.
func TestAnthropicGatewayUsageAfterMessageStop(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		write := func(s string) {
			_, _ = w.Write([]byte(s))
			if fl != nil {
				fl.Flush()
			}
		}
		write("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":38}}}\n\n")
		write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
		write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"135\"}}\n\n")
		write("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
		write("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n")
		write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
		// provider retry replay after stop: stale usage + no stop change
		write("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"},\"usage\":{\"output_tokens\":99}}\n\n")
		write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
		write(": x-gateway-usage in=38,cache=0,out=3\n\n")
	}))
	defer srv.Close()

	c := NewAnthropic("x", srv.URL)
	evs, err := c.Stream(context.Background(), Request{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	var usage Usage
	var done EventDone
	var text string
	for ev := range evs {
		switch e := ev.(type) {
		case EventTextDelta:
			text += e.Delta
		case EventUsage:
			usage = e.Usage
		case EventDone:
			done = e
		}
	}
	if text != "135" {
		t.Fatalf("text=%q", text)
	}
	if usage.InputTokens != 38 || usage.OutputTokens != 3 {
		t.Fatalf("usage=%+v want in=38 out=3", usage)
	}
	if done.Stop != StopEnd {
		t.Fatalf("stop=%v want StopEnd (first reason wins, not max_tokens replay)", done.Stop)
	}
}

func TestAnthropicRedactedThinkingRoundTrip(t *testing.T) {
	const blob = "Q-PaDgFwOh2-a9QtXVxufcTIhYxZYEDDmu2n2cDsKwkH"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		write := func(s string) {
			_, _ = w.Write([]byte(s))
			if fl != nil {
				fl.Flush()
			}
		}
		write("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":10}}}\n\n")
		// Encrypted thinking arrives whole in content_block_start (no deltas).
		write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"redacted_thinking\",\"data\":\"" + blob + "\"}}\n\n")
		write("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
		write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
		write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Entendido\"}}\n\n")
		write("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n")
		write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer srv.Close()

	c := NewAnthropic("x", srv.URL)
	evs, err := c.Stream(context.Background(), Request{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	var done EventDone
	for ev := range evs {
		if e, ok := ev.(EventDone); ok {
			done = e
		}
	}
	if len(done.Message.Content) != 2 {
		t.Fatalf("content blocks=%d want 2 (redacted + text)", len(done.Message.Content))
	}
	rb, ok := done.Message.Content[0].(ReasoningBlock)
	if !ok || rb.Encrypted != blob {
		t.Fatalf("first block=%+v want ReasoningBlock with blob", done.Message.Content[0])
	}
	if tb, ok := done.Message.Content[1].(TextBlock); !ok || tb.Text != "Entendido" {
		t.Fatalf("second block=%+v", done.Message.Content[1])
	}

	// Replay: the next turn must carry the blob verbatim, in position.
	ac := c.(*anthropicClient)
	wire, err := ac.buildRequest(Request{
		Model: "m",
		Messages: []Message{
			{Role: RoleUser, Content: []Content{TextBlock{Text: "Escolha uma palavra secreta."}}},
			done.Message,
			{Role: RoleUser, Content: []Content{TextBlock{Text: "Qual foi?"}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(wire.Messages[1].Content)
	var blocks []struct {
		Type string `json:"type"`
		Data string `json:"data"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 2 || blocks[0].Type != "redacted_thinking" || blocks[0].Data != blob {
		t.Fatalf("replayed blocks=%s", raw)
	}
	if blocks[1].Type != "text" || blocks[1].Text != "Entendido" {
		t.Fatalf("replayed blocks=%s", raw)
	}
}

func TestAnthropicTruncatedToolCallErrors(t *testing.T) {
	// The stream announces a tool_use block and then dies: connection
	// closed, no message_delta, no message_stop. The turn must fail
	// loudly (retryable) instead of passing an empty-arguments tool
	// call as a clean end_turn.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		write := func(s string) {
			_, _ = w.Write([]byte(s))
			if fl != nil {
				fl.Flush()
			}
		}
		write("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":10}}}\n\n")
		write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu9\",\"name\":\"write\"}}\n\n")
	}))
	defer srv.Close()

	c := NewAnthropic("x", srv.URL)
	evs, err := c.Stream(context.Background(), Request{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	var done EventDone
	var starts int
	for ev := range evs {
		switch e := ev.(type) {
		case EventToolStart:
			starts++
		case EventDone:
			done = e
		}
	}
	if starts != 1 {
		t.Fatalf("starts=%d want 1", starts)
	}
	if done.Stop != StopError || done.Err == nil {
		t.Fatalf("stop=%v err=%v want StopError with truncated-response error", done.Stop, done.Err)
	}
	if got := done.Err.Error(); !strings.Contains(got, "truncated") {
		t.Fatalf("err=%q want truncated-response error", got)
	}
}

func TestAnthropicErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"authentication_error","message":"bad"}}`))
	}))
	defer srv.Close()

	c := NewAnthropic("x", srv.URL)
	_, err := c.Stream(context.Background(), Request{Model: "m"})
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("want 401 err, got %v", err)
	}
}

// No sampling parameters are ever sent: reasoning-only models (e.g.
// gpt-5.6-luna via gateway translation) reject `temperature` outright,
// so the wire payload must never carry the key, whatever the model.
func TestAnthropicNeverSendsTemperature(t *testing.T) {
	for _, model := range []Model{
		{ID: "m"},
		{ID: "m", Reasoning: true},
	} {
		c := NewGatewayAnthropic("gw_key", "http://gw/anthropic/v1", model).(*anthropicClient)
		wire, err := c.buildRequest(Request{Model: "m", MaxTokens: 512,
			Messages: []Message{{Role: RoleUser, Content: []Content{TextBlock{Text: "hi"}}}}})
		if err != nil {
			t.Fatal(err)
		}
		body, err := json.Marshal(wire)
		if err != nil {
			t.Fatal(err)
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if _, ok := payload["temperature"]; ok {
			t.Fatalf("model %+v: payload must never carry temperature: %s", model, body)
		}
	}
}

// Stream errors must return a CLOSED channel (never nil): callers range
// over it, and ranging over nil blocks forever (caught on Windows where
// fork/regenerate/queue turns spun 10-30s on 'unsupported protocol
// scheme' instead of failing fast).
func TestAnthropicStreamErrorClosesChannel(t *testing.T) {
	c := NewGatewayAnthropic("k", "/relative-no-scheme", Model{ID: "m"}).(*anthropicClient)
	ch, err := c.Stream(t.Context(), Request{Model: "m", MaxTokens: 10, Messages: []Message{{Role: RoleUser, Content: []Content{TextBlock{Text: "hi"}}}}})
	if err == nil {
		t.Fatal("expected error for relative URL")
	}
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("closed channel must not yield events")
		}
	default:
		t.Fatal("error channel must be closed (would block range forever)")
	}
}

func TestAnthropicBuildRequestMergesToolAndUserSteering(t *testing.T) {
	c := NewGatewayAnthropic("gw_key", "http://gw/anthropic/v1", Model{ID: "m"}).(*anthropicClient)
	wire, err := c.buildRequest(Request{
		Model:     "m",
		MaxTokens: 512,
		Messages: []Message{
			{Role: RoleUser, Content: []Content{TextBlock{Text: "run something"}}},
			{Role: RoleAssistant, Content: []Content{
				ToolCallBlock{ID: "t1", Name: "bash", Arguments: json.RawMessage(`{"cmd":"ls"}`)},
			}},
			{Role: RoleTool, Content: []Content{
				ToolResultBlock{CallID: "t1", Content: []Content{TextBlock{Text: "file.txt"}}},
			}},
			// Live steering user message appended right after tool results:
			{Role: RoleUser, Content: []Content{TextBlock{Text: "Also check dir2"}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Tool + live steering must merge into a single "user" turn (len 3: user, assistant, user).
	if len(wire.Messages) != 3 {
		t.Fatalf("expected 3 wire messages, got %d", len(wire.Messages))
	}
	lastBlocks, ok := wire.Messages[2].Content.([]interface{})
	if !ok || len(lastBlocks) != 2 {
		t.Fatalf("expected 2 blocks in merged user turn, got %v", wire.Messages[2].Content)
	}
	if _, isTool := lastBlocks[0].(anthToolResultBlock); !isTool {
		t.Fatalf("first block must be tool_result, got %T", lastBlocks[0])
	}
	if tb, isText := lastBlocks[1].(anthTextBlock); !isText || tb.Text != "Also check dir2" {
		t.Fatalf("second block must be steering text block, got %v", lastBlocks[1])
	}
}
