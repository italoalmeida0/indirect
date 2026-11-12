package provider

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestContextTokensOmitsBareReasoningSummary(t *testing.T) {
	base := []Message{
		{Role: RoleUser, Content: []Content{TextBlock{Text: "solve this"}}},
		{Role: RoleAssistant, Content: []Content{TextBlock{Text: "done"}}},
	}
	withBareSummary := []Message{
		{Role: RoleUser, Content: []Content{TextBlock{Text: "solve this"}}},
		{
			Role: RoleAssistant,
			Content: []Content{
				ReasoningBlock{Summary: strings.Repeat("verbose transcript-only reasoning ", 200)},
				TextBlock{Text: "done"},
			},
		},
	}
	baseTok := ContextTokens("sys", nil, base)
	sumTok := ContextTokens("sys", nil, withBareSummary)
	if sumTok != baseTok {
		t.Fatalf("bare ReasoningBlock.Summary must not inflate ContextTokens: got %d, want %d", sumTok, baseTok)
	}

	// Pure bare-summary assistant message serializes to nothing on the wire and in ContextTokensByMessage.
	summaryOnly := []Message{
		{Role: RoleUser, Content: []Content{TextBlock{Text: "solve this"}}},
		{Role: RoleAssistant, Content: []Content{ReasoningBlock{Summary: "only thinking"}}},
	}
	_, per := ContextTokensByMessage("sys", nil, summaryOnly)
	if len(per) != 1 {
		t.Fatalf("expected summary-only assistant turn to be omitted, got per=%v", per)
	}

	// Encrypted thinking payload IS replayed on the wire and MUST still count.
	rawRand := make([]byte, 384)
	if _, err := rand.Read(rawRand); err != nil {
		t.Fatal(err)
	}
	encBlob := base64.StdEncoding.EncodeToString(rawRand)
	asstMsg := Message{
		Role: RoleAssistant,
		Content: []Content{
			ReasoningBlock{Encrypted: encBlob, Summary: "ignored summary"},
			TextBlock{Text: "done"},
		},
	}
	role, countedContent := anthropicCountMessage(asstMsg)
	if role != "assistant" {
		t.Fatalf("role=%q, want assistant", role)
	}
	countedBlocks, ok := countedContent.([]any)
	if !ok || len(countedBlocks) != 2 {
		t.Fatalf("expected [redacted_thinking, text], got %#v", countedContent)
	}
	withEncrypted := []Message{
		{Role: RoleUser, Content: []Content{TextBlock{Text: "solve this"}}},
		asstMsg,
	}
	encTok := ContextTokens("sys", nil, withEncrypted)
	if encTok <= baseTok {
		t.Fatalf("encrypted ReasoningBlock must still count: got %d <= %d", encTok, baseTok)
	}
}

func TestAnthropicFourthCacheControlOnCompactionLastBlock(t *testing.T) {
	c := NewGatewayAnthropic("gw_key", "http://gw/anthropic/v1", Model{ID: "m", ContextWindow: 200000, MaxOutput: 8192}).(*anthropicClient)

	req := Request{
		Model:  "m",
		System: "system instructions",
		Tools: []Tool{
			{Name: "read", Description: "read file", Schema: json.RawMessage(`{"type":"object"}`)},
		},
		Messages: []Message{
			{
				Role:    RoleUser,
				Content: []Content{TextBlock{Text: "<system-reminder>## Context Summary (compacted)\n\nblock b1</system-reminder>"}},
				Meta:    map[string]string{"compaction": "true", "block_id": "b1"},
			},
			{
				Role:    RoleUser,
				Content: []Content{TextBlock{Text: "<system-reminder>## Context Summary (compacted)\n\nblock b2</system-reminder>"}},
				Meta:    map[string]string{"compaction": "true", "block_id": "b2", "compaction_last_block": "true"},
			},
			{
				Role:    RoleUser,
				Content: []Content{TextBlock{Text: "first kept user message"}},
			},
			{
				Role:    RoleAssistant,
				Content: []Content{TextBlock{Text: "kept assistant reply"}},
			},
			{
				Role:    RoleUser,
				Content: []Content{TextBlock{Text: "latest user question"}},
			},
		},
	}

	_, body, err := c.BuildWireRequest(req)
	if err != nil {
		t.Fatalf("BuildWireRequest: %v", err)
	}
	if strings.Contains(string(body), `"tool_choice"`) {
		t.Fatalf("tool_choice must stay omitted on wire: %s", body)
	}

	var parsed struct {
		System []struct {
			CacheControl *anthCacheControl `json:"cache_control"`
		} `json:"system"`
		Tools []struct {
			CacheControl *anthCacheControl `json:"cache_control"`
		} `json:"tools"`
		Messages []struct {
			Role    string `json:"role"`
			Content []struct {
				Type         string            `json:"type"`
				Text         string            `json:"text"`
				CacheControl *anthCacheControl `json:"cache_control"`
			} `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("unmarshal wire: %v", err)
	}

	// Coalesced opening user message: [b1, b2, first kept user]
	if len(parsed.Messages) != 3 {
		t.Fatalf("expected 3 coalesced messages (user, assistant, user), got %d", len(parsed.Messages))
	}
	firstUser := parsed.Messages[0].Content
	if len(firstUser) != 3 {
		t.Fatalf("expected 3 blocks in coalesced opening user message, got %d", len(firstUser))
	}
	if firstUser[0].CacheControl != nil {
		t.Fatalf("b1 must NOT carry cache_control: %+v", firstUser[0])
	}
	if firstUser[1].CacheControl == nil || firstUser[1].CacheControl.Type != "ephemeral" {
		t.Fatalf("b2 (compaction_last_block) must carry ephemeral cache_control: %+v", firstUser[1])
	}
	if firstUser[2].CacheControl != nil {
		t.Fatalf("first kept user after b2 must NOT carry cache_control when a later user turn exists: %+v", firstUser[2])
	}
	lastUser := parsed.Messages[2].Content
	if len(lastUser) != 1 || lastUser[0].CacheControl == nil || lastUser[0].CacheControl.Type != "ephemeral" {
		t.Fatalf("final user turn must carry ephemeral cache_control: %+v", lastUser)
	}

	totalCC := strings.Count(string(body), `"cache_control"`)
	if totalCC != 4 {
		t.Fatalf("expected exactly 4 cache_control breakpoints (system + tools + b2 + lastUser), got %d:\n%s", totalCC, body)
	}
}

func TestAnthropicCompactionCacheControlDeduplicatesAndNeverExceedsFour(t *testing.T) {
	c := NewGatewayAnthropic("gw_key", "http://gw/anthropic/v1", Model{ID: "m", ContextWindow: 200000, MaxOutput: 8192}).(*anthropicClient)

	// Case 1: compaction_last_block IS the final block of the last user message -> deduplicated (3 total).
	_, bodySingle, err := c.BuildWireRequest(Request{
		Model:  "m",
		System: "sys",
		Tools:  []Tool{{Name: "read", Schema: json.RawMessage(`{"type":"object"}`)}},
		Messages: []Message{
			{
				Role:    RoleUser,
				Content: []Content{TextBlock{Text: "b1"}},
				Meta:    map[string]string{"compaction": "true", "compaction_last_block": "true"},
			},
			{
				Role:    RoleAssistant,
				Content: []Content{TextBlock{Text: "reply"}},
			},
		},
	})
	if err != nil {
		t.Fatalf("BuildWireRequest single: %v", err)
	}
	if got := strings.Count(string(bodySingle), `"cache_control"`); got != 3 {
		t.Fatalf("deduplicated cache_control count = %d, want 3:\n%s", got, bodySingle)
	}

	// Case 2: even if multiple messages mistakenly carry compaction_last_block=true, total <= 4.
	_, bodyMulti, err := c.BuildWireRequest(Request{
		Model:  "m",
		System: "sys",
		Tools:  []Tool{{Name: "read", Schema: json.RawMessage(`{"type":"object"}`)}},
		Messages: []Message{
			{
				Role:    RoleUser,
				Content: []Content{TextBlock{Text: "b1"}},
				Meta:    map[string]string{"compaction_last_block": "true"},
			},
			{
				Role:    RoleUser,
				Content: []Content{TextBlock{Text: "b2"}},
				Meta:    map[string]string{"compaction_last_block": "true"},
			},
			{
				Role:    RoleAssistant,
				Content: []Content{TextBlock{Text: "mid"}},
			},
			{
				Role:    RoleUser,
				Content: []Content{TextBlock{Text: "tail"}},
			},
		},
	})
	if err != nil {
		t.Fatalf("BuildWireRequest multi: %v", err)
	}
	if got := strings.Count(string(bodyMulti), `"cache_control"`); got > 4 {
		t.Fatalf("cache_control count exceeded Anthropic max 4: got %d:\n%s", got, bodyMulti)
	}
}

func TestAnthropicSummarizerForkPreservesPrevLastUserCacheControl(t *testing.T) {
	c := NewGatewayAnthropic("gw_key", "http://gw/anthropic/v1", Model{ID: "claude-sonnet-4-5", ContextWindow: 200000, MaxOutput: 8192}).(*anthropicClient)
	tools := []Tool{{Name: "read", Description: "read file", Schema: json.RawMessage(`{"type":"object"}`)}}

	type wireBlock struct {
		Type         string            `json:"type"`
		Text         string            `json:"text"`
		ToolUseID    string            `json:"tool_use_id"`
		CacheControl *anthCacheControl `json:"cache_control"`
	}
	type wireShape struct {
		Messages []struct {
			Role    string      `json:"role"`
			Content []wireBlock `json:"content"`
		} `json:"messages"`
	}
	parseWire := func(t *testing.T, req Request) (string, wireShape) {
		t.Helper()
		_, body, err := c.BuildWireRequest(req)
		if err != nil {
			t.Fatalf("BuildWireRequest: %v", err)
		}
		var parsed wireShape
		if err := json.Unmarshal(body, &parsed); err != nil {
			t.Fatalf("unmarshal wire: %v\n%s", err, body)
		}
		return string(body), parsed
	}

	t.Run("assistant_then_summarizer_fork", func(t *testing.T) {
		body, parsed := parseWire(t, Request{
			Model:  "claude-sonnet-4-5",
			System: "sys",
			Tools:  tools,
			Messages: []Message{
				{
					Role:    RoleUser,
					Content: []Content{TextBlock{Text: "block b1"}},
					Meta:    map[string]string{"compaction": "true", "block_id": "b1", "compaction_last_block": "true"},
				},
				{Role: RoleAssistant, Content: []Content{TextBlock{Text: "ack"}}},
				{Role: RoleUser, Content: []Content{TextBlock{Text: "real last user"}}},
				{Role: RoleAssistant, Content: []Content{TextBlock{Text: "assistant reply"}}},
				{
					Role:    RoleUser,
					Content: []Content{TextBlock{Text: "<system-reminder>INTERNAL COMPACTION FORK</system-reminder>"}},
					Meta:    map[string]string{"compaction": "summarizer_fork"},
				},
			},
		})
		if len(parsed.Messages) != 5 {
			t.Fatalf("expected 5 wire messages, got %d", len(parsed.Messages))
		}
		if cc := parsed.Messages[2].Content[0].CacheControl; cc == nil || cc.Type != "ephemeral" {
			t.Fatalf("prevLastUser lost cache_control: %+v", parsed.Messages[2].Content[0])
		}
		if cc := parsed.Messages[4].Content[0].CacheControl; cc != nil {
			t.Fatalf("throwaway summarizer_fork must NOT carry cache_control: %+v", parsed.Messages[4].Content[0])
		}
		if got := strings.Count(body, `"cache_control"`); got != 4 {
			t.Fatalf("expected 4 cache_control slots (sys + tools + b1 + prevLastUser), got %d:\n%s", got, body)
		}
	})

	t.Run("coalesced_user_then_summarizer_fork", func(t *testing.T) {
		body, parsed := parseWire(t, Request{
			Model:  "claude-sonnet-4-5",
			System: "sys",
			Tools:  tools,
			Messages: []Message{
				{Role: RoleUser, Content: []Content{TextBlock{Text: "prompt before fork"}}},
				{
					Role:    RoleUser,
					Content: []Content{TextBlock{Text: "<system-reminder>INTERNAL COMPACTION FORK</system-reminder>"}},
					Meta:    map[string]string{"compaction": "summarizer_fork"},
				},
			},
		})
		if len(parsed.Messages) != 1 || len(parsed.Messages[0].Content) != 2 {
			t.Fatalf("expected 1 coalesced user message with 2 blocks, got %+v", parsed.Messages)
		}
		if cc := parsed.Messages[0].Content[0].CacheControl; cc == nil || cc.Type != "ephemeral" {
			t.Fatalf("block 0 (prompt before fork) must carry cache_control: %+v", parsed.Messages[0].Content[0])
		}
		if cc := parsed.Messages[0].Content[1].CacheControl; cc != nil {
			t.Fatalf("block 1 (coalesced summarizer_fork) must NOT carry cache_control: %+v", parsed.Messages[0].Content[1])
		}
		if got := strings.Count(body, `"cache_control"`); got != 3 {
			t.Fatalf("expected 3 cache_control slots (sys + tools + prompt), got %d:\n%s", got, body)
		}
	})

	t.Run("coalesced_tool_result_then_summarizer_fork", func(t *testing.T) {
		body, parsed := parseWire(t, Request{
			Model:  "claude-sonnet-4-5",
			System: "sys",
			Tools:  tools,
			Messages: []Message{
				{Role: RoleUser, Content: []Content{TextBlock{Text: "read file"}}},
				{
					Role: RoleAssistant,
					Content: []Content{
						ToolCallBlock{ID: "tc-1", Name: "read", Arguments: json.RawMessage(`{"path":"a.go"}`)},
					},
				},
				{
					Role: RoleTool,
					Content: []Content{
						ToolResultBlock{CallID: "tc-1", Content: []Content{TextBlock{Text: "package a"}}},
					},
				},
				{
					Role:    RoleUser,
					Content: []Content{TextBlock{Text: "<system-reminder>INTERNAL COMPACTION FORK</system-reminder>"}},
					Meta:    map[string]string{"compaction": "summarizer_fork"},
				},
			},
		})
		if len(parsed.Messages) != 3 {
			t.Fatalf("expected 3 wire messages (user, assistant, coalesced tool+fork user), got %d", len(parsed.Messages))
		}
		tailBlocks := parsed.Messages[2].Content
		if len(tailBlocks) != 2 || tailBlocks[0].Type != "tool_result" {
			t.Fatalf("expected [tool_result, text], got %+v", tailBlocks)
		}
		if cc := tailBlocks[0].CacheControl; cc == nil || cc.Type != "ephemeral" {
			t.Fatalf("tool_result block must keep Breakpoint 4 cache_control: %+v", tailBlocks[0])
		}
		if cc := tailBlocks[1].CacheControl; cc != nil {
			t.Fatalf("coalesced summarizer_fork block must NOT carry cache_control: %+v", tailBlocks[1])
		}
		if got := strings.Count(body, `"cache_control"`); got != 3 {
			t.Fatalf("expected 3 cache_control slots, got %d:\n%s", got, body)
		}
	})

	t.Run("deduplicated_compaction_last_block_plus_summarizer_fork", func(t *testing.T) {
		body, parsed := parseWire(t, Request{
			Model:  "claude-sonnet-4-5",
			System: "sys",
			Tools:  tools,
			Messages: []Message{
				{
					Role:    RoleUser,
					Content: []Content{TextBlock{Text: "b1"}},
					Meta:    map[string]string{"compaction": "true", "compaction_last_block": "true"},
				},
				{Role: RoleAssistant, Content: []Content{TextBlock{Text: "reply"}}},
				{
					Role:    RoleUser,
					Content: []Content{TextBlock{Text: "<system-reminder>INTERNAL COMPACTION FORK</system-reminder>"}},
					Meta:    map[string]string{"compaction": "summarizer_fork"},
				},
			},
		})
		if cc := parsed.Messages[0].Content[0].CacheControl; cc == nil || cc.Type != "ephemeral" {
			t.Fatalf("compaction_last_block missing cache_control: %+v", parsed.Messages[0].Content[0])
		}
		if cc := parsed.Messages[2].Content[0].CacheControl; cc != nil {
			t.Fatalf("summarizer_fork must NOT carry cache_control: %+v", parsed.Messages[2].Content[0])
		}
		if got := strings.Count(body, `"cache_control"`); got != 3 {
			t.Fatalf("deduplicated cache_control count = %d, want 3:\n%s", got, body)
		}
	})
}
