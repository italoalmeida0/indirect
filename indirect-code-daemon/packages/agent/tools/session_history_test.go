package tools

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"testing"
	"unicode/utf8"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"
)

func TestCodeAwareTokenizeSplitsSymbolsPathsAndAvoidsFuzzyNgrams(t *testing.T) {
	cases := []struct {
		name       string
		input      string
		wantSubs   []string
		wantExacts []string
	}{
		{
			name:       "camelCase",
			input:      "refreshModelMirror",
			wantSubs:   []string{"refresh", "model", "mirror"},
			wantExacts: []string{"refreshmodelmirror"},
		},
		{
			name:       "PascalCase_with_acronym",
			input:      "HTTPServerConfig",
			wantSubs:   []string{"http", "server", "config"},
			wantExacts: []string{"httpserverconfig"},
		},
		{
			name:       "snake_case",
			input:      "session_actor_mailbox",
			wantSubs:   []string{"session", "actor", "mailbox"},
			wantExacts: []string{"session_actor_mailbox"},
		},
		{
			name:       "kebab_case",
			input:      "indirect-code-daemon",
			wantSubs:   []string{"indirect", "code", "daemon"},
			wantExacts: []string{"indirect-code-daemon"},
		},
		{
			name:  "path_with_ext_and_line",
			input: "cmd/daemon/session_actor.go:142",
			wantSubs: []string{
				"cmd", "daemon", "session", "actor", "go", "142",
			},
			wantExacts: []string{
				"cmd/daemon/session_actor.go:142",
				"cmd/daemon/session_actor.go",
				"session_actor.go",
				"session_actor",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			subs, exacts := codeAwareTokenize(tc.input)
			for _, want := range tc.wantSubs {
				if !sliceContains(subs, want) {
					t.Fatalf("input %q missing sub-token %q in %v", tc.input, want, subs)
				}
			}
			for _, want := range tc.wantExacts {
				if !sliceContains(exacts, want) {
					t.Fatalf("input %q missing exact-token %q in %v", tc.input, want, exacts)
				}
			}
		})
	}

	// Verify zero fuzzy Latin character n-gram pollution: "authentication"
	// must NOT emit 3-grams like "aut", "the", "ent", "tic".
	subs, exacts := codeAwareTokenize("authentication")
	if len(exacts) != 0 {
		t.Fatalf("plain prose word should not be indexed as exact code token, got %v", exacts)
	}
	if len(subs) != 1 || subs[0] != "authentication" {
		t.Fatalf("plain prose word must stay single token without n-grams, got %v", subs)
	}
}

func TestSessionHistoryBM25ExactIdentifierAndPathBoost(t *testing.T) {
	msgs := []provider.Message{
		{
			Role: provider.RoleAssistant,
			Content: []provider.Content{
				provider.TextBlock{Text: "We should refresh the view in model.go and update mirror helpers soon."},
			},
		},
		{
			Role: provider.RoleAssistant,
			Content: []provider.Content{
				provider.TextBlock{Text: "Updated refreshModelMirror to synchronize fallback chain rows atomically."},
			},
		},
		{
			Role: provider.RoleAssistant,
			Content: []provider.Content{
				provider.TextBlock{Text: "The session and actor design keeps go mailboxes bounded."},
			},
		},
		{
			Role: provider.RoleAssistant,
			Content: []provider.Content{
				provider.TextBlock{Text: "Fixed quarantine counter inside cmd/daemon/session_actor.go:142."},
			},
		},
	}

	tool := &SessionHistoryTool{
		Source: func() SessionHistorySnapshot {
			return SessionHistorySnapshot{
				Messages: msgs,
				KeepFrom: len(msgs),
				Blocks: []SessionHistoryBlock{
					{ID: "b1", Tier: 1, StartIdx: 0, EndIdx: 4, Topic: "mirror & actor", Summary: "Initial implementation pass."},
				},
			}
		},
	}

	// 1. Exact camelCase query outranks scattered sub-tokens (msg #1 beats msg #0).
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action": "search",
		"query":  "refreshModelMirror",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	body := envBody(t, res)
	idxExact := strings.Index(body, "[msg #1 · assistant · block b1]")
	idxScattered := strings.Index(body, "[msg #0 · assistant · block b1]")
	if idxExact < 0 || idxScattered < 0 || idxExact > idxScattered {
		t.Fatalf("expected exact identifier match msg #1 to outrank scattered sub-tokens msg #0:\n%s", body)
	}

	// 2. All-lowercase query "refreshmodelmirror" STILL hits exact camelCase symbol in msg #1!
	resLow, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action": "search",
		"query":  "refreshmodelmirror",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := envBody(t, resLow); !strings.Contains(got, "[msg #1 · assistant · block b1]") {
		t.Fatalf("expected lowercase query to match camelCase symbol in msg #1:\n%s", got)
	}

	// 3. Exact file path query outranks prose containing individual path words (msg #3 beats msg #2).
	resPath, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action": "search",
		"query":  "cmd/daemon/session_actor.go",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	pathBody := envBody(t, resPath)
	idxPathHit := strings.Index(pathBody, "[msg #3 · assistant · block b1]")
	idxProseHit := strings.Index(pathBody, "[msg #2 · assistant · block b1]")
	if idxPathHit < 0 || (idxProseHit >= 0 && idxPathHit > idxProseHit) {
		t.Fatalf("expected exact path match msg #3 to rank first:\n%s", pathBody)
	}
}

func TestSessionHistoryRoleWeights(t *testing.T) {
	// Identical token count and TF=1 for "quorumtoken" across user, assistant, tool, and block.
	msgs := []provider.Message{
		{
			Role:    provider.RoleTool,
			Content: []provider.Content{provider.TextBlock{Text: "quorumtoken alpha beta gamma"}},
		},
		{
			Role:    provider.RoleAssistant,
			Content: []provider.Content{provider.TextBlock{Text: "quorumtoken alpha beta gamma"}},
		},
		{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: "quorumtoken alpha beta gamma"}},
		},
	}
	snap := SessionHistorySnapshot{
		Messages: msgs,
		KeepFrom: len(msgs),
		Blocks: []SessionHistoryBlock{
			{
				ID:       "b1",
				Tier:     1,
				StartIdx: 0,
				EndIdx:   3,
				Summary:  "quorumtoken alpha beta", //+"b1" makes 4 sub-tokens = identical docLen!
			},
		},
	}
	docs := buildHistoryDocs(snap, snap.KeepFrom, snap.KeepFrom)
	hits, _ := bm25SearchDocs(docs, "quorumtoken", 10)
	if len(hits) != 4 {
		t.Fatalf("expected 4 hits, got %d", len(hits))
	}
	wantOrder := []string{"user", "block", "assistant", "tool"}
	for i, wantRole := range wantOrder {
		if hits[i].doc.role != wantRole {
			t.Fatalf("rank %d: want role %q, got %q (score=%.4f)", i, wantRole, hits[i].doc.role, hits[i].score)
		}
	}
	// Verify exact weight ratios against assistant (1.0): user=1.5, block=1.2, tool=0.6.
	assistantScore := hits[2].score
	if math.Abs(hits[0].score/assistantScore-1.5) > 1e-6 {
		t.Fatalf("user/assistant ratio = %.4f, want 1.5", hits[0].score/assistantScore)
	}
	if math.Abs(hits[1].score/assistantScore-1.2) > 1e-6 {
		t.Fatalf("block/assistant ratio = %.4f, want 1.2", hits[1].score/assistantScore)
	}
	if math.Abs(hits[3].score/assistantScore-0.6) > 1e-6 {
		t.Fatalf("tool/assistant ratio = %.4f, want 0.6", hits[3].score/assistantScore)
	}
}

func TestSessionHistoryKeepFromLiveTailAndRetiredT1Indexing(t *testing.T) {
	msgs := []provider.Message{
		{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: "Investigate deadlock in walCheckpointer"}},
		},
		{
			Role:    provider.RoleAssistant,
			Content: []provider.Content{provider.TextBlock{Text: "Found lock inversion in walCheckpointer"}},
		},
		{
			// Synthetic system warn must never pollute search hits.
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: "<system-warn>walCheckpointer synthetic nudge</system-warn>"}},
		},
		{
			// Live tail message (index >= KeepFrom=3).
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: "Now check liveTailSentinelBehavior in router.ts"}},
		},
	}
	blocks := []SessionHistoryBlock{
		{
			ID:               "b1",
			Tier:             1,
			StartIdx:         0,
			EndIdx:           2,
			Topic:            "WAL checkpointing",
			Summary:          "Retired T1 detail mentioning legacyBoltAdapter",
			RetiredByBlockID: "b2",
		},
		{
			ID:       "b2",
			Tier:     2,
			StartIdx: 0,
			EndIdx:   3,
			Topic:    "Storage rollup",
			Summary:  "Active T2 rollup covering WAL lock fix",
		},
		{
			ID:               "b0_old_t2",
			Tier:             2,
			StartIdx:         0,
			EndIdx:           1,
			Summary:          "Retired T2 mentioning obsoleteTierTwoGhost",
			RetiredByBlockID: "b2",
		},
	}

	tool := &SessionHistoryTool{
		Source: func() SessionHistorySnapshot {
			return SessionHistorySnapshot{
				Messages: msgs,
				KeepFrom: 3,
				Blocks:   blocks,
			}
		},
	}

	// 1. Live tail excluded by default.
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action": "search",
		"query":  "liveTailSentinelBehavior",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if envAttr(res, "hits") != "0" {
		t.Fatalf("expected 0 hits when include_live_tail=false, got:\n%s", envBody(t, res))
	}

	// 2. Live tail included when include_live_tail=true.
	resLive, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action":            "search",
		"query":             "liveTailSentinelBehavior",
		"include_live_tail": true,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := envBody(t, resLive); !strings.Contains(got, "[msg #3 · user · block live]") {
		t.Fatalf("expected live tail hit msg #3:\n%s", got)
	}

	// 3. Retired Tier-1 block IS searchable and includes exact recall arguments.
	resT1, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action": "search",
		"query":  "legacyBoltAdapter",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	t1Body := envBody(t, resT1)
	if !strings.Contains(t1Body, "b1 (retired->b2)") || !strings.Contains(t1Body, `"block_id":"b1"`) {
		t.Fatalf("expected retired T1 block hit with recall args:\n%s", t1Body)
	}

	// 4. Retired Tier-2 block is NOT indexed (only active blocks + retired T1 blocks).
	resT2, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action": "search",
		"query":  "obsoleteTierTwoGhost",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if envAttr(resT2, "hits") != "0" {
		t.Fatalf("expected retired T2 block not to be indexed, got:\n%s", envBody(t, resT2))
	}
}

func TestSessionHistoryRecallVerbatimPaginationAndUTF8Safety(t *testing.T) {
	unprunedToolOutput := "HEADER-LINE\n" + strings.Repeat("🔥日本語-verbatim-log-entry-0123456789\n", 120) + "FOOTER-SENTINEL"
	wrappedContent := core.WrapToolResultContent(core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: unprunedToolOutput}},
		Attrs:   []core.Attr{{Key: "exit", Value: "0"}},
	})

	origMsgs := []provider.Message{
		{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: "Run diagnostics on shard 7"}},
		},
		{
			Role: provider.RoleAssistant,
			Content: []provider.Content{
				provider.TextBlock{Text: "Running shard check now."},
				provider.ToolCallBlock{
					ID:        "call_shard_7",
					Name:      "bash",
					Arguments: json.RawMessage(`{"command":"./check-shard --id=7"}`),
				},
			},
		},
		{
			Role: provider.RoleTool,
			Content: []provider.Content{
				provider.ToolResultBlock{
					CallID:  "call_shard_7",
					Content: wrappedContent,
				},
			},
		},
	}

	tool := &SessionHistoryTool{
		Source: func() SessionHistorySnapshot {
			return SessionHistorySnapshot{
				Messages: origMsgs,
				KeepFrom: 3,
				Blocks: []SessionHistoryBlock{
					{ID: "b1", Tier: 1, StartIdx: 0, EndIdx: 3, Topic: "shard check", Summary: "Ran shard 7 check."},
				},
			}
		},
	}

	// Full recall by block_id returns user text, assistant text + tool call args, and unpruned tool output.
	resFull, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action":   "recall",
		"block_id": "b1",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	fullBody := envBody(t, resFull)
	for _, needle := range []string{
		"Run diagnostics on shard 7",
		"Running shard check now.",
		"[tool_call id=call_shard_7 name=bash]",
		`{"command":"./check-shard --id=7"}`,
		"[tool_result call_id=call_shard_7 tool=bash is_error=false]",
		"HEADER-LINE",
		"FOOTER-SENTINEL",
	} {
		if !strings.Contains(fullBody, needle) {
			t.Fatalf("recall output missing %q:\n%s", needle, fullBody[:min(400, len(fullBody))])
		}
	}
	if envAttr(resFull, "truncated") != "false" {
		t.Fatalf("expected truncated=false on full recall, got %q", envAttr(resFull, "truncated"))
	}

	// Paginated recall by start_msg..end_msg with tight max_chars across multi-byte UTF-8 boundaries.
	offset := 0
	pages := 0
	var reconstructed strings.Builder
	for {
		pages++
		if pages > 50 {
			t.Fatal("pagination did not terminate")
		}
		resPage, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
			"action":       "recall",
			"start_msg":    0,
			"end_msg":      2,
			"offset_chars": offset,
			"max_chars":    900,
		}), nil)
		if err != nil {
			t.Fatal(err)
		}
		pageBody := envBody(t, resPage)
		if !utf8.ValidString(pageBody) {
			t.Fatalf("page %d contains invalid UTF-8 at offset %d", pages, offset)
		}
		if envAttr(resPage, "truncated") == "true" {
			markerIdx := strings.LastIndex(pageBody, "\n\n[... recall paginated:")
			if markerIdx < 0 {
				t.Fatalf("expected pagination footer on truncated page %d", pages)
			}
			reconstructed.WriteString(pageBody[:markerIdx])
			nextStr := envAttr(resPage, "next_offset")
			if nextStr == "" {
				t.Fatal("missing next_offset attr on truncated page")
			}
			var next int
			if err := json.Unmarshal([]byte(nextStr), &next); err != nil || next <= offset {
				t.Fatalf("invalid next_offset %q from offset %d", nextStr, offset)
			}
			offset = next
		} else {
			reconstructed.WriteString(pageBody)
			break
		}
	}
	if pages < 4 {
		t.Fatalf("expected multiple pages, got %d", pages)
	}
	if reconstructed.String() != fullBody {
		t.Fatalf("paginated recall did not losslessly reconstruct full body (got %d bytes, want %d bytes)",
			reconstructed.Len(), len(fullBody))
	}
}
