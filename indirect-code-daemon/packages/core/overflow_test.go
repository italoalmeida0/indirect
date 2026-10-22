package core

import (
	"context"
	"errors"
	"testing"

	"indirect/indirect-code-daemon/packages/provider"
)

func TestIsContextOverflow(t *testing.T) {
	tests := []struct {
		msg  string
		want bool
	}{
		{
			msg:  `openai: http 400: {"error":{"message":"This endpoint's maximum context length is 1048576 tokens. However, you requested about 1048902 tokens (104161 of text input, 1023 of tool input, 943718 in the output). Please reduce the length of either one, or use the context-compression plugin to compress your prompt automatically.","code":400,"metadata":{"provider_name":null}}}`,
			want: true,
		},
		{
			msg:  `context_length_exceeded: Your request exceeds the context window of 128000 tokens`,
			want: true,
		},
		{
			msg:  `prompt is too long for this model`,
			want: true,
		},
		{
			msg:  `maximum context length is 200000 tokens. However, your messages resulted in 205000 tokens`,
			want: true,
		},
		{
			msg:  `input length (150000 tokens) exceeds context length (128000)`,
			want: true,
		},
		{
			msg:  `rate limit exceeded: too many requests per minute`,
			want: false,
		},
		{
			msg:  `500 Internal Server Error`,
			want: false,
		},
		{
			msg:  `401 unauthorized: invalid api key`,
			want: false,
		},
	}

	for _, tt := range tests {
		got := IsContextOverflow(errors.New(tt.msg))
		if got != tt.want {
			t.Errorf("IsContextOverflow(%q) = %v; want %v", tt.msg, got, tt.want)
		}
	}
}

func TestIsRetryableUpstream(t *testing.T) {
	retryable := []string{
		"gateway-anthropic: http 429: rate limited",
		"gateway-anthropic: http 500: internal error",
		"gateway-anthropic: http 503: overloaded",
		"connection reset by peer",
		"prompt is too long for requested model", // compaction path
	}
	for _, msg := range retryable {
		if !isRetryableUpstream(errors.New(msg)) {
			t.Fatalf("must retry: %q", msg)
		}
	}
	fatal := []string{
		"gateway-anthropic: http 400: {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Function tools with reasoning_effort are not supported\"}}",
		"gateway-anthropic: http 401: unauthorized",
		"gateway-anthropic: http 403: forbidden",
		"Unsupported value: 'temperature' does not support 0.7 with this model",
		"Unsupported parameter: 'max_tokens' is not supported with this model",
		`anthropic: Post "/anthropic/v1/messages": unsupported protocol scheme ""`,
	}
	for _, msg := range fatal {
		if isRetryableUpstream(errors.New(msg)) {
			t.Fatalf("must NOT retry: %q", msg)
		}
	}
}

func TestContextOverflowRecoveryOnShortTranscript(t *testing.T) {
	calls := 0
	c := &scriptableFakeClient{
		summaries: []string{"Compacted summary."},
	}
	client := &overflowMockClient{
		onStream: func(req provider.Request) (<-chan provider.Event, error) {
			calls++
			if calls == 1 {
				return nil, errors.New("prompt is too long for requested model")
			}
			return c.Stream(context.Background(), req)
		},
	}
	a := NewAgent(client, "m", "", Registry{})
	a.messages = []provider.Message{
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "first user"}}},
		{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "first reply"}}},
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "second user"}}},
	}

	err := a.Prompt(context.Background(), "third user", nil, nil)
	if err != nil {
		t.Fatalf("Prompt failed: %v", err)
	}
	if calls != 2 {
		t.Fatalf("expected 2 calls (1 overflow, 1 success after compact), got %d", calls)
	}
	if a.compactionState == nil {
		t.Fatal("expected compaction state to be set after overflow recovery")
	}
}

type overflowMockClient struct {
	onStream func(provider.Request) (<-chan provider.Event, error)
}

func (m *overflowMockClient) Name() string { return "overflow-mock" }
func (m *overflowMockClient) Stream(ctx context.Context, req provider.Request) (<-chan provider.Event, error) {
	if req.System == SummarizationSystemPrompt {
		out := make(chan provider.Event, 8)
		out <- provider.EventStart{Provider: "overflow-mock", Model: req.Model}
		out <- provider.EventTextDelta{Delta: "Summary."}
		out <- provider.EventUsage{Usage: provider.Usage{InputTokens: 10, OutputTokens: 5}}
		out <- provider.EventDone{Stop: provider.StopEnd, Message: provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "Summary."}}}}
		close(out)
		return out, nil
	}
	return m.onStream(req)
}
