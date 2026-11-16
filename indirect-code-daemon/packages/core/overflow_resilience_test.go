package core

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"indirect/indirect-code-daemon/packages/provider"
)

func TestParseUpstreamContextLimit(t *testing.T) {
	cases := []struct {
		err  string
		want int
	}{
		{
			err:  `anthropic: http 400: {"error":{"message":"This model's maximum context length is 131072 tokens. However, you requested 449701 tokens.","type":"invalid_request_error"}}`,
			want: 131072,
		},
		{
			err:  `gateway: http 400: Range of input length should be [1, 131072]`,
			want: 131072,
		},
		{
			err:  `vllm: input_tokens (200000) exceeds max_model_len=65536`,
			want: 65536,
		},
		{
			err:  `context_length_exceeded: Your request exceeds the context window of 128,000 tokens`,
			want: 128000,
		},
	}
	for _, tc := range cases {
		if !IsContextOverflow(errors.New(tc.err)) {
			t.Fatalf("IsContextOverflow(%q) = false; want true", tc.err)
		}
		if got := ParseUpstreamContextLimit(errors.New(tc.err)); got != tc.want {
			t.Fatalf("ParseUpstreamContextLimit(%q) = %d; want %d", tc.err, got, tc.want)
		}
	}
}

type deepseekCeilingClient struct {
	ceilingToks  int
	warmForkHits atomic.Int32
	standalone   atomic.Int32
	mainCalls    atomic.Int32
}

func (c *deepseekCeilingClient) Name() string { return "gateway-anthropic" }

func (c *deepseekCeilingClient) Stream(_ context.Context, req provider.Request) (<-chan provider.Event, error) {
	toks := provider.ContextTokens(req.System, req.Tools, req.Messages)
	isStandaloneSummarizer := req.System == SummarizationSystemPrompt
	isWarmFork := false
	if len(req.Messages) > 0 {
		last := req.Messages[len(req.Messages)-1]
		if last.Meta != nil && last.Meta["compaction"] == "summarizer_fork" {
			isWarmFork = true
		}
	}
	if isWarmFork {
		c.warmForkHits.Add(1)
	} else if isStandaloneSummarizer {
		c.standalone.Add(1)
	} else {
		c.mainCalls.Add(1)
	}

	if toks > c.ceilingToks {
		return nil, fmt.Errorf(
			`gateway-anthropic: http 400: {"type":"error","error":{"type":"invalid_request_error","message":"This model's maximum context length is %d tokens. However, you requested %d tokens. Please reduce the length of the messages."}}`,
			c.ceilingToks, toks,
		)
	}

	replyText := "Compacted era summary with key findings."
	if !isStandaloneSummarizer && !isWarmFork {
		replyText = "Recovered and continuing APK analysis cleanly."
	}
	ch := make(chan provider.Event, 4)
	ch <- provider.EventStart{Provider: c.Name(), Model: req.Model}
	ch <- provider.EventTextDelta{Delta: replyText}
	ch <- provider.EventUsage{Usage: provider.Usage{InputTokens: toks, OutputTokens: 24}}
	ch <- provider.EventDone{
		Stop: provider.StopEnd,
		Message: provider.Message{
			Role:    provider.RoleAssistant,
			Content: []provider.Content{provider.TextBlock{Text: replyText}},
		},
	}
	close(ch)
	return ch, nil
}

// Reproduces the .apk 8boll incident: session advertises 524,288 windowTokens
// ("infinite:small:vision") while the concrete DeepSeek target enforces 131,072
// tokens and the transcript has grown well past 131,072 tokens.
func TestOverflowRecoverySkipsWarmForkAndLearnsRealModelCeiling(t *testing.T) {
	client := &deepseekCeilingClient{ceilingToks: 32000}
	ag := NewAgent(client, "infinite:small:vision", "You are an autonomous agent.", NewRegistry())
	ag.PersistentTurns = true

	// Build a ~90k-token transcript (> 32k upstream ceiling, < 524k catalog window).
	chunk := strings.Repeat("00559380: stp x29, x30, [sp, #-0x50]! disassembly line\n", 450)
	var msgs []provider.Message
	for i := 0; i < 16; i++ {
		callID := fmt.Sprintf("call_%d", i)
		msgs = append(msgs,
			provider.Message{
				Role: provider.RoleUser,
				Content: []provider.Content{
					provider.TextBlock{Text: fmt.Sprintf("Step %d inspection request", i)},
				},
			},
			provider.Message{
				Role: provider.RoleAssistant,
				Content: []provider.Content{
					provider.ToolCallBlock{ID: callID, Name: "search", Arguments: []byte(`{"pattern":"stp"}`)},
				},
			},
			provider.Message{
				Role: provider.RoleTool,
				Content: []provider.Content{
					provider.ToolResultBlock{
						CallID:  callID,
						Content: []provider.Content{provider.TextBlock{Text: chunk}},
					},
				},
			},
			provider.Message{
				Role: provider.RoleAssistant,
				Content: []provider.Content{
					provider.TextBlock{Text: "Inspected disassembly block."},
				},
			},
		)
	}
	ag.SetMessages(msgs)

	var persisted *CompactionState
	ag.OnCompactionState = func(s *CompactionState) {
		persisted = s.Clone()
	}

	if err := ag.Prompt(context.Background(), "continue", nil, nil); err != nil {
		t.Fatalf("Prompt failed instead of recovering from catalog/upstream window mismatch: %v", err)
	}
	if got := client.warmForkHits.Load(); got != 0 {
		t.Fatalf("CompactOverflow must skip warm-fork re-uploads of overflowing prefix, got %d warm-fork calls", got)
	}
	if persisted == nil || persisted.LearnedContextWindow != 32000 || persisted.LearnedContextModel != "infinite:small:vision" {
		t.Fatalf("expected LearnedContextWindow=32000 persisted on CompactionState, got %+v", persisted)
	}
	if eff := ag.EffectiveContextWindow(524288); eff != 32000 {
		t.Fatalf("EffectiveContextWindow(524288) = %d; want 32000", eff)
	}
	// Switching to a different model must not stay clamped to the previous model's ceiling.
	ag.Model = "claude-opus-4-6"
	if eff := ag.EffectiveContextWindow(1000000); eff != 1000000 {
		t.Fatalf("EffectiveContextWindow after model switch = %d; want 1000000", eff)
	}
}
