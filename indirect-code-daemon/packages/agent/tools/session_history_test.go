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
		pageDet, ok := resPage.Details.(map[string]any)
		if !ok {
			t.Fatalf("expected Details map on recall page %d, got %T", pages, resPage.Details)
		}
		if pageDet["action"] != "recall" || pageDet["block_id"] != "" || pageDet["start_msg"] != 0 || pageDet["end_msg"] != 2 || pageDet["total_chars"] != len(fullBody) {
			t.Fatalf("unexpected recall page Details: %#v", pageDet)
		}
		if envAttr(resPage, "truncated") == "true" {
			if pageDet["truncated"] != true {
				t.Fatalf("expected Details[truncated]=true on truncated page, got %#v", pageDet["truncated"])
			}
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
			if pageDet["next_offset"] != next {
				t.Fatalf("Details[next_offset] = %v, want %d", pageDet["next_offset"], next)
			}
			offset = next
		} else {
			if pageDet["truncated"] != false || pageDet["next_offset"] != 0 {
				t.Fatalf("expected terminal page Details truncated=false next_offset=0, got %#v", pageDet)
			}
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

func TestSessionHistorySearchAndRecallStructuredAttrsAndDetailsContract(t *testing.T) {
	// 1. Empty compacted history branch (KeepFrom=0, Blocks=nil, 2 live messages).
	emptyTool := &SessionHistoryTool{
		Source: func() SessionHistorySnapshot {
			return SessionHistorySnapshot{
				Messages: []provider.Message{
					{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "live turn 1"}}},
					{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "live turn 2"}}},
				},
				KeepFrom: 0,
			}
		},
	}
	resEmpty, err := emptyTool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action": "search",
		"query":  "anything",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if envAttr(resEmpty, "action") != "search" || envAttr(resEmpty, "hits") != "0" || envAttr(resEmpty, "indexed") != "0" || envAttr(resEmpty, "live_tail") != "" {
		t.Fatalf("unexpected empty-history search Attrs: %+v", resEmpty.Attrs)
	}
	detEmpty, ok := resEmpty.Details.(map[string]any)
	if !ok {
		t.Fatalf("expected Details map on empty search, got %T", resEmpty.Details)
	}
	if detEmpty["action"] != "search" || detEmpty["query"] != "anything" || detEmpty["indexed"] != 0 || detEmpty["include_live_tail"] != false {
		t.Fatalf("unexpected empty-history search Details: %#v", detEmpty)
	}
	if emptyHits, ok := detEmpty["hits"].([]map[string]any); !ok || len(emptyHits) != 0 {
		t.Fatalf("expected empty non-nil []map[string]any hits slice, got %#v", detEmpty["hits"])
	}

	// 2. Rich snapshot covering 0 hits, active Tier-2 block hit, retired Tier-1 block hit,
	// compacted message hit, and live-tail message hit.
	msgs := []provider.Message{
		{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: "Audit tokenQuotaAdmission inside server/billing.ts"}},
		},
		{
			Role:    provider.RoleAssistant,
			Content: []provider.Content{provider.TextBlock{Text: "Verified atomic balance reservation in tokenQuotaAdmission."}},
		},
		{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: "Check liveStreamCanaryMarker in server/relay.ts"}},
		},
	}
	blocks := []SessionHistoryBlock{
		{
			ID:               "b1",
			Tier:             1,
			StartIdx:         0,
			EndIdx:           2,
			Topic:            "Quota admission",
			Summary:          "Retired Tier-1 note covering retiredChecksumBeaconX1 invariant.",
			RetiredByBlockID: "b2",
		},
		{
			ID:       "b2",
			Tier:     2,
			StartIdx: 0,
			EndIdx:   2,
			Topic:    "Billing rollup",
			Summary:  "Active Tier-2 rollup covering activeJournalSentinelZ9 invariant.",
		},
	}
	tool := &SessionHistoryTool{
		Source: func() SessionHistorySnapshot {
			return SessionHistorySnapshot{
				Messages: msgs,
				KeepFrom: 2,
				Blocks:   blocks,
			}
		},
	}

	// 2a. Zero hits over indexed docs (2 compacted msgs + 2 blocks = 4 indexed).
	resZero, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action": "search",
		"query":  "nonexistentSymbolXyz999",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if envAttr(resZero, "action") != "search" || envAttr(resZero, "hits") != "0" || envAttr(resZero, "indexed") != "4" || envAttr(resZero, "live_tail") != "" {
		t.Fatalf("unexpected 0-hit Attrs: %+v", resZero.Attrs)
	}
	detZero := resZero.Details.(map[string]any)
	if detZero["indexed"] != 4 || detZero["include_live_tail"] != false || len(detZero["hits"].([]map[string]any)) != 0 {
		t.Fatalf("unexpected 0-hit Details: %#v", detZero)
	}

	// 2b. Active Tier-2 block hit.
	resBlock, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action": "search",
		"query":  "activeJournalSentinelZ9",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if envAttr(resBlock, "action") != "search" || envAttr(resBlock, "hits") != "1" || envAttr(resBlock, "indexed") != "4" {
		t.Fatalf("unexpected block-hit Attrs: %+v", resBlock.Attrs)
	}
	detBlock := resBlock.Details.(map[string]any)
	blockHits := detBlock["hits"].([]map[string]any)
	if len(blockHits) != 1 {
		t.Fatalf("expected 1 block hit in Details, got %d", len(blockHits))
	}
	bh := blockHits[0]
	if bh["kind"] != "block" || bh["role"] != "block" || bh["block_id"] != "b2" || bh["retired_by"] != "" ||
		bh["tier"] != 2 || bh["start_idx"] != 0 || bh["end_idx"] != 1 || bh["topic"] != "Billing rollup" {
		t.Fatalf("unexpected active block hit item: %#v", bh)
	}
	if score, ok := bh["score"].(float64); !ok || score <= 0 {
		t.Fatalf("expected positive rounded float64 score, got %#v", bh["score"])
	}
	if snip, ok := bh["snippet"].(string); !ok || !strings.Contains(snip, "activeJournalSentinelZ9") {
		t.Fatalf("expected snippet containing query token, got %#v", bh["snippet"])
	}

	// 2c. Retired Tier-1 block hit.
	resRet, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action": "search",
		"query":  "retiredChecksumBeaconX1",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	retHits := resRet.Details.(map[string]any)["hits"].([]map[string]any)
	if len(retHits) != 1 {
		t.Fatalf("expected 1 retired T1 hit, got %d", len(retHits))
	}
	rh := retHits[0]
	if rh["kind"] != "block" || rh["block_id"] != "b1" || rh["retired_by"] != "b2" ||
		rh["tier"] != 1 || rh["start_idx"] != 0 || rh["end_idx"] != 1 || rh["topic"] != "Quota admission" {
		t.Fatalf("unexpected retired T1 block hit item: %#v", rh)
	}

	// 2d. Message hits + include_live_tail=true (3 msgs + 2 blocks = 5 indexed).
	resLive, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action":            "search",
		"query":             "liveStreamCanaryMarker",
		"include_live_tail": true,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if envAttr(resLive, "action") != "search" || envAttr(resLive, "hits") != "1" ||
		envAttr(resLive, "indexed") != "5" || envAttr(resLive, "live_tail") != "true" {
		t.Fatalf("unexpected live-tail search Attrs: %+v", resLive.Attrs)
	}
	detLive := resLive.Details.(map[string]any)
	if detLive["include_live_tail"] != true || detLive["indexed"] != 5 {
		t.Fatalf("unexpected live-tail Details: %#v", detLive)
	}
	liveHits := detLive["hits"].([]map[string]any)
	if len(liveHits) != 1 {
		t.Fatalf("expected 1 live message hit, got %d", len(liveHits))
	}
	mh := liveHits[0]
	if mh["kind"] != "message" || mh["msg_idx"] != 2 || mh["role"] != "user" || mh["block_id"] != "live" ||
		mh["retired_by"] != "" || !strings.Contains(mh["snippet"].(string), "liveStreamCanaryMarker") {
		t.Fatalf("unexpected message hit item: %#v", mh)
	}

	// 3. Recall by block_id (both normal window and offset >= totalChars branch).
	resRecall, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action":   "recall",
		"block_id": "b1",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if envAttr(resRecall, "action") != "recall" || envAttr(resRecall, "block_id") != "b1" ||
		envAttr(resRecall, "start_msg") != "0" || envAttr(resRecall, "end_msg") != "1" ||
		envAttr(resRecall, "truncated") != "false" || envAttr(resRecall, "next_offset") != "" {
		t.Fatalf("unexpected block recall Attrs: %+v", resRecall.Attrs)
	}
	detRecall := resRecall.Details.(map[string]any)
	totalChars := len(envBody(t, resRecall))
	if detRecall["action"] != "recall" || detRecall["block_id"] != "b1" ||
		detRecall["start_msg"] != 0 || detRecall["end_msg"] != 1 ||
		detRecall["offset_chars"] != 0 || detRecall["total_chars"] != totalChars ||
		detRecall["truncated"] != false || detRecall["next_offset"] != 0 {
		t.Fatalf("unexpected block recall Details: %#v", detRecall)
	}

	// Past-end offset on block_id recall MUST preserve block_id in both Attrs and Details.
	resPastEnd, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"action":       "recall",
		"block_id":     "b1",
		"offset_chars": totalChars + 50,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if envAttr(resPastEnd, "block_id") != "b1" || envAttr(resPastEnd, "truncated") != "false" {
		t.Fatalf("past-end block recall lost block_id or truncated attr: %+v", resPastEnd.Attrs)
	}
	detPast := resPastEnd.Details.(map[string]any)
	if detPast["block_id"] != "b1" || detPast["offset_chars"] != totalChars+50 ||
		detPast["total_chars"] != totalChars || detPast["truncated"] != false || detPast["next_offset"] != 0 {
		t.Fatalf("unexpected past-end recall Details: %#v", detPast)
	}
}
