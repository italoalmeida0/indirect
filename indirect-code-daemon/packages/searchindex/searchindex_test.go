package searchindex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"indirect/indirect-code-daemon/packages/provider"
)

// 1. Agentic finish_entire_request + summary indexing & synthetic/hidden exclusion.
func TestAgenticExtractionAndExclusions(t *testing.T) {
	dir := t.TempDir()
	idx, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer idx.Close()

	finishArgs, _ := json.Marshal(map[string]string{
		"final_message_to_user": "Implemented seekable Zstd cold frame index with zero-copy pread.",
	})
	summaryArgs, _ := json.Marshal(map[string]string{
		"for_user": "Auditing deadlock hazard in actor supervisor mailbox drainage.",
		"for_me":   "private scratchpad token_alpha_secret",
	})
	legacySummaryArgs, _ := json.Marshal(map[string]string{
		"summary": "Migrated legacy jsonl transcripts using streaming linereader.",
	})
	bashArgs, _ := json.Marshal(map[string]string{
		"command": "go test -race ./packages/proctable/...",
	})

	// Build a giant 2,000-token tool output where a decoy token sits at position 1,200 (> 512 cap).
	var giantDump strings.Builder
	for i := 0; i < 900; i++ {
		fmt.Fprintf(&giantDump, "fillerword%d ", i)
	}
	giantDump.WriteString("overflow_beyond_512_cap_decoy ")

	msgs := []provider.Message{
		// Turn 1 (msgs 0..2): User with stacked <system-reminder> + attachment, Assistant prose
		{
			Role:      provider.RoleUser,
			TurnIndex: 1,
			Meta: map[string]string{
				"attachments": `[{"id":"att-spec","name":"architecture_v2.md"}]`,
			},
			Content: []provider.Content{
				provider.TextBlock{Text: "<system-reminder>\nCurrent date: 2026-11-13\ndirective_decoy_omega\n</system-reminder>"},
				provider.TextBlock{Text: "<system_prompt>system_prompt_decoy_beta</system_prompt>\nHow should we structure workspace isolation?"},
			},
		},
		{
			Role:      provider.RoleAssistant,
			TurnIndex: 1,
			Content: []provider.Content{
				provider.TextBlock{Text: "Each worker uses an isolated worktree directory."},
			},
		},
		// Hidden background_delivery & skill_notice synthetic user messages in Turn 1: MUST NOT be indexed!
		{
			Role:      provider.RoleUser,
			TurnIndex: 1,
			Meta:      map[string]string{"background_delivery": "job-99"},
			Content:   []provider.Content{provider.TextBlock{Text: "bg_delivery_decoy_secret completed exit 0"}},
		},
		{
			Role:      provider.RoleUser,
			TurnIndex: 1,
			Meta:      map[string]string{"skill_notice": "skill-deactivated"},
			Content:   []provider.Content{provider.TextBlock{Text: "skill_notice_decoy_secret deactivated"}},
		},
		{
			Role:      provider.RoleUser,
			TurnIndex: 1,
			Meta:      map[string]string{"hidden": "true"},
			Content:   []provider.Content{provider.TextBlock{Text: "hidden_meta_decoy_secret"}},
		},

		// Turn 2 (msgs 5..8): Agentic turn with summary + bash tool +giant result + finish_entire_request (ZERO TextBlocks on assistant!)
		{
			Role:      provider.RoleUser,
			TurnIndex: 2,
			Content: []provider.Content{
				provider.TextBlock{Text: "Optimize cold storage reads <system-reminder>inline_reminder_decoy</system-reminder> now."},
			},
		},
		{
			Role:      provider.RoleAssistant,
			TurnIndex: 2,
			Content: []provider.Content{
				provider.ToolCallBlock{ID: "call-sum-1", Name: "summary", Arguments: summaryArgs},
				provider.ToolCallBlock{ID: "call-sum-2", Name: "summary", Arguments: legacySummaryArgs},
				provider.ToolCallBlock{ID: "call-bash-1", Name: "bash", Arguments: bashArgs},
			},
		},
		{
			Role:      provider.RoleTool,
			TurnIndex: 2,
			Content: []provider.Content{
				provider.ToolResultBlock{
					CallID:  "call-bash-1",
					Content: []provider.Content{provider.TextBlock{Text: `<tool_result type="ok" exit="0">` + giantDump.String() + `</tool_result>`}},
				},
			},
		},
		{
			Role:      provider.RoleAssistant,
			TurnIndex: 2,
			Content: []provider.Content{
				provider.ToolCallBlock{ID: "call-fin-1", Name: "finish_entire_request", Arguments: finishArgs},
			},
		},
	}

	turns := ExtractSessionTurns("sess-agentic", msgs, &ExtractOptions{
		AttachmentText: map[string]string{
			"att-spec": "Extracted specification covering zero-allocation ringbuffers.",
		},
		Widgets: []WidgetMeta{
			{ID: "latency_flamegraph", Title: "Latency Flamegraph Explorer"},
		},
		CompactionBlocks: []CompactionBlockMeta{
			{ID: "fold-1", Topic: "Initial Ringbuffer Audit", Summary: "Summarized lock-free ringbuffer invariants.", StartIdx: 0, EndIdx: 5},
		},
	})

	if len(turns) != 2 {
		t.Fatalf("expected 2 extracted turns, got %d", len(turns))
	}
	if err := idx.IndexSessionTurns("sess-agentic", SessionMeta{
		Title:     "Storage Engine Overhaul",
		CWD:       "/workspace/daemon",
		UpdatedAt: 1700000100,
	}, turns); err != nil {
		t.Fatalf("IndexSessionTurns: %v", err)
	}

	ctx := context.Background()

	// Verify finish_entire_request.final_message_to_user is indexed as FieldAssistant at exact msgIdx=8!
	hits, err := idx.Search(ctx, Query{Text: "seekable Zstd pread"})
	if err != nil {
		t.Fatalf("Search finish_entire_request: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("expected 1 hit for finish_entire_request, got %d", len(hits))
	}
	if hits[0].Field != "assistant" {
		t.Fatalf("expected field=assistant, got %q", hits[0].Field)
	}
	if hits[0].TurnIndex != 2 || hits[0].MessageIdx != 8 {
		t.Fatalf("expected TurnIndex=2 MessageIdx=8, got TurnIndex=%d MessageIdx=%d", hits[0].TurnIndex, hits[0].MessageIdx)
	}
	if !strings.Contains(hits[0].Snippet, "seekable Zstd") {
		t.Fatalf("expected snippet to contain finish_entire_request text, got %q", hits[0].Snippet)
	}

	// Verify summary tool (both for_user and summary keys) is indexed in FieldAssistant!
	for _, qStr := range []string{"deadlock hazard mailbox", "streaming linereader"} {
		h, err := idx.Search(ctx, Query{Text: qStr})
		if err != nil || len(h) != 1 {
			t.Fatalf("expected 1 hit for summary query %q, got %v (err=%v)", qStr, h, err)
		}
		if h[0].Field != "assistant" {
			t.Fatalf("expected field=assistant for %q, got %q", qStr, h[0].Field)
		}
	}

	// Verify out-of-line attachment text + filename indexed in FieldUser at msgIdx=0!
	attHits, err := idx.Search(ctx, Query{Text: "ringbuffers architecture_v2.md"})
	if err != nil || len(attHits) != 1 {
		t.Fatalf("expected attachment hit, got %v (err=%v)", attHits, err)
	}
	if attHits[0].Field != "user" || attHits[0].MessageIdx != 0 {
		t.Fatalf("expected field=user MessageIdx=0, got field=%s MessageIdx=%d", attHits[0].Field, attHits[0].MessageIdx)
	}

	// Verify bash command, widget ID/title, and compaction summary indexed in FieldTool!
	for _, toolQ := range []string{"proctable", "latency_flamegraph", "Summarized lock-free"} {
		th, err := idx.Search(ctx, Query{Text: toolQ})
		if err != nil || len(th) != 1 {
			t.Fatalf("expected tool hit for %q, got %v (err=%v)", toolQ, th, err)
		}
		if th[0].Field != "tool" {
			t.Fatalf("expected field=tool for %q, got %q", toolQ, th[0].Field)
		}
	}

	// Verify ALL decoys (<system-reminder>, <system_prompt>, background_delivery, skill_notice, hidden, private for_me, >512 tool cap) are EXCLUDED!
	for _, forbidden := range []string{
		"directive_decoy_omega",
		"system_prompt_decoy_beta",
		"inline_reminder_decoy",
		"bg_delivery_decoy_secret",
		"skill_notice_decoy_secret",
		"hidden_meta_decoy_secret",
		"token_alpha_secret",
		"overflow_beyond_512_cap_decoy",
	} {
		fh, err := idx.Search(ctx, Query{Text: forbidden, DisablePrefix: true})
		if err != nil {
			t.Fatalf("Search(%q): %v", forbidden, err)
		}
		if len(fh) != 0 {
			t.Fatalf("expected 0 hits for excluded decoy %q, got %+v", forbidden, fh)
		}
	}
}

// 2. Multilingual PT-BR diacritic folding, code-aware tokens, field boosts, and 0.65x prefix expansion.
func TestMultilingualTokenizerCodeAndPrefix(t *testing.T) {
	dir := t.TempDir()
	idx, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer idx.Close()

	// Session 1: PT-BR accented prose (NFC + NFD combining tilde/acute)
	if err := idx.IndexSessionTurns("pt-br", SessionMeta{
		Title:     "Otimização de Memória e Sessão",
		CWD:       "/app",
		UpdatedAt: 1000,
	}, []TurnDoc{
		{
			SessionID:            "pt-br",
			TurnIndex:            1,
			FirstMsgIdx:          0,
			BestUserOrAsstMsgIdx: 1,
			UserText:             "Precisamos revisar a configuração da função de autenticação.",
			// NFD decomposed "sessa\u0303o" and "memo\u0301ria"
			AssistantText: "A sessa\u0303o agora economiza memo\u0301ria sem travamentos.",
		},
	}); err != nil {
		t.Fatal(err)
	}

	// Session 2: Code identifiers & file paths (SessionActor, store_wal.go, pkg/path/file.ts:123)
	if err := idx.IndexSessionTurns("code-toks", SessionMeta{
		Title:     "Code Symbols Investigation",
		CWD:       "/app",
		UpdatedAt: 1000,
	}, []TurnDoc{
		{
			SessionID:            "code-toks",
			TurnIndex:            1,
			FirstMsgIdx:          4,
			BestUserOrAsstMsgIdx: 5,
			UserText:             "Inspect SessionActor and store_wal.go plus pkg/path/file.ts:123",
			AssistantText:        "Updated kebab-case-token and HTTPServerConfig.",
		},
	}); err != nil {
		t.Fatal(err)
	}

	// Session 3 & 4: Exact ("compact", 1.0x) vs Prefix ("compaction", 0.65x)
	if err := idx.IndexSessionTurns("pfx-only", SessionMeta{
		Title:     "Tiered Compaction Worker",
		CWD:       "/app",
		UpdatedAt: 1000,
	}, []TurnDoc{
		{
			SessionID:            "pfx-only",
			TurnIndex:            1,
			FirstMsgIdx:          0,
			BestUserOrAsstMsgIdx: 1,
			AssistantText:        "Background compaction merges LSM segments.",
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := idx.IndexSessionTurns("exact-compact", SessionMeta{
		Title:     "Tiered Compact Worker",
		CWD:       "/app",
		UpdatedAt: 1000,
	}, []TurnDoc{
		{
			SessionID:            "exact-compact",
			TurnIndex:            1,
			FirstMsgIdx:          0,
			BestUserOrAsstMsgIdx: 1,
			AssistantText:        "Background compact merges LSM segments.",
		},
	}); err != nil {
		t.Fatal(err)
	}

	// Flush to verify both MemTable and on-disk Sparse Dictionary Block prefix/lookup paths!
	if err := idx.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	ctx := context.Background()

	// Check PT-BR unaccented queries matching accented text and vice versa.
	for _, q := range []string{
		"sessao",
		"sessão",
		"memoria",
		"memória",
		"configuracao",
		"configuração",
		"funcao",
		"função",
		"autenticacao",
	} {
		hits, err := idx.Search(ctx, Query{Text: q, DisablePrefix: true})
		if err != nil {
			t.Fatalf("Search(%q): %v", q, err)
		}
		if len(hits) == 0 || hits[0].SessionID != "pt-br" {
			t.Fatalf("expected pt-br hit for %q, got %+v", q, hits)
		}
	}

	// Check camelCase, PascalCase, snake_case, kebab-case, and path:line tokens.
	for _, codeQ := range []string{
		"session",
		"actor",
		"sessionactor",
		"SessionActor",
		"store",
		"wal",
		"store_wal",
		"store_wal.go",
		"file.ts",
		"path/file.ts",
		"pkg/path/file.ts",
		"pkg/path/file.ts:123",
		"http",
		"server",
		"httpserverconfig",
		"kebab-case-token",
	} {
		hits, err := idx.Search(ctx, Query{Text: codeQ, DisablePrefix: true})
		if err != nil {
			t.Fatalf("Search(%q): %v", codeQ, err)
		}
		found := false
		for _, h := range hits {
			if h.SessionID == "code-toks" {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("expected code-toks hit for %q, got %+v", codeQ, hits)
		}
	}

	// Check live prefix typing: "compac" matches both "compaction" and "compact"!
	pfxHits, err := idx.Search(ctx, Query{Text: "compac"})
	if err != nil {
		t.Fatalf("Search(compac): %v", err)
	}
	if len(pfxHits) < 2 {
		t.Fatalf("expected >=2 prefix hits for 'compac', got %+v", pfxHits)
	}

	// Check exact "compact" (1.0x) strictly outranks prefix "compaction" (0.65x)!
	exactVsPfx, err := idx.Search(ctx, Query{Text: "compact"})
	if err != nil {
		t.Fatalf("Search(compact): %v", err)
	}
	if len(exactVsPfx) < 2 || exactVsPfx[0].SessionID != "exact-compact" {
		t.Fatalf("expected exact-compact (1.0x) to outrank pfx-only (0.65x), got %+v", exactVsPfx)
	}
	if exactVsPfx[0].Score <= exactVsPfx[1].Score {
		t.Fatalf("expected exact score > prefix score, got %.4f vs %.4f", exactVsPfx[0].Score, exactVsPfx[1].Score)
	}

	// Check 4-field BM25F boost ordering: Title (4.0) > User (2.0) > Assistant (1.8) > Tool (1.0).
	dirBoost := t.TempDir()
	bIdx, err := Open(dirBoost)
	if err != nil {
		t.Fatal(err)
	}
	defer bIdx.Close()

	_ = bIdx.IndexSessionTurns("f-title", SessionMeta{Title: "zyxwvut alpha beta", UpdatedAt: 1000}, nil)
	_ = bIdx.IndexSessionTurns("f-user", SessionMeta{Title: "ordinary one", UpdatedAt: 1000}, []TurnDoc{
		{SessionID: "f-user", TurnIndex: 1, UserText: "zyxwvut alpha beta"},
	})
	_ = bIdx.IndexSessionTurns("f-asst", SessionMeta{Title: "ordinary two", UpdatedAt: 1000}, []TurnDoc{
		{SessionID: "f-asst", TurnIndex: 1, AssistantText: "zyxwvut alpha beta"},
	})
	_ = bIdx.IndexSessionTurns("f-tool", SessionMeta{Title: "ordinary three", UpdatedAt: 1000}, []TurnDoc{
		{SessionID: "f-tool", TurnIndex: 1, ToolText: "zyxwvut alpha beta"},
	})
	_ = bIdx.Flush()

	bHits, err := bIdx.Search(ctx, Query{Text: "zyxwvut", DisablePrefix: true})
	if err != nil {
		t.Fatal(err)
	}
	wantOrder := []string{"f-title", "f-user", "f-asst", "f-tool"}
	if len(bHits) != 4 {
		t.Fatalf("expected 4 hits, got %d", len(bHits))
	}
	for i, want := range wantOrder {
		if bHits[i].SessionID != want {
			t.Fatalf("rank %d: got %s (score=%.3f, field=%s), want %s", i, bHits[i].SessionID, bHits[i].Score, bHits[i].Field, want)
		}
	}
}

// 3. UTF-8 multi-byte rune snippet slicing safety (PT-BR, 4-byte emojis, CJK, invalid UTF-8).
func TestUTF8RuneSafeSnippets(t *testing.T) {
	dir := t.TempDir()
	idx, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer idx.Close()

	// Build multi-byte heavy strings > 300 runes so both 512-rune .sdoc truncation
	// and ~120-rune snippet windowing cut directly across multi-byte regions.
	ptEmojiPrefix := strings.Repeat("🔥🚀🎉 coração ação sessão memória configuração ótimo ", 5)
	cjkMid := strings.Repeat("日本語のセッション検索エンジン高速化テスト🧪", 4)
	targetPhrase := "chave_secreta_encontrada_aqui 🌟✨ configuração_final"
	suffix := strings.Repeat(" 👨\u200d👩\u200d👧\u200d👦 café maçã avião caminhão revisão", 6)

	fullText := ptEmojiPrefix + cjkMid + " " + targetPhrase + suffix

	// Also inject invalid raw UTF-8 bytes in another session to prove unconditional UTF-8 safety.
	invalidUTF8 := string([]byte{0xff, 0xfe, 'a', 'b'}) + " " + strings.Repeat("🚀áéíóú漢字 ", 30) + " marcador_especial " + string([]byte{0xc3, 0x28})

	if err := idx.IndexSessionTurns("utf8-rich", SessionMeta{
		Title:     "Teste UTF-8 Completo 🚀 " + strings.Repeat("sessão ", 25),
		UpdatedAt: 2000,
	}, []TurnDoc{
		{
			SessionID:            "utf8-rich",
			TurnIndex:            3,
			FirstMsgIdx:          12,
			BestUserOrAsstMsgIdx: 14,
			AssistantText:        fullText,
		},
	}); err != nil {
		t.Fatal(err)
	}

	if err := idx.IndexSessionTurns("utf8-invalid", SessionMeta{
		Title:     "Invalid Bytes Recovery",
		UpdatedAt: 1900,
	}, []TurnDoc{
		{
			SessionID:            "utf8-invalid",
			TurnIndex:            1,
			FirstMsgIdx:          2,
			BestUserOrAsstMsgIdx: 3,
			UserText:             invalidUTF8,
		},
	}); err != nil {
		t.Fatal(err)
	}

	// Test both before Flush (MemTable) and after Flush (.sdoc compressed store).
	for pass := 0; pass < 2; pass++ {
		if pass == 1 {
			if err := idx.Flush(); err != nil {
				t.Fatalf("Flush: %v", err)
			}
		}
		for _, snippetLen := range []int{40, 80, 120, 160} {
			for _, q := range []string{"chave_secreta_encontrada_aqui", "configuracao_final", "検索エンジン", "marcador_especial", "Completo"} {
				hits, err := idx.Search(context.Background(), Query{
					Text:         q,
					SnippetRunes: snippetLen,
				})
				if err != nil {
					t.Fatalf("pass=%d Search(%q): %v", pass, q, err)
				}
				if len(hits) == 0 {
					t.Fatalf("pass=%d expected hit for %q", pass, q)
				}
				for _, h := range hits {
					if !utf8.ValidString(h.Snippet) {
						t.Fatalf("pass=%d q=%q len=%d produced INVALID UTF-8 snippet: %x", pass, q, snippetLen, []byte(h.Snippet))
					}
					if strings.ContainsRune(h.Snippet, '\ufffd') && h.SessionID == "utf8-rich" {
						t.Fatalf("pass=%d q=%q len=%d corrupted valid multi-byte rune into U+FFFD: %q", pass, q, snippetLen, h.Snippet)
					}
				}
			}
		}
	}
}

// 4. Rename (O(1) UpdateSessionMeta), Idempotent Upsert, TruncateSessionFromTurn, DeleteSession, Reopen, and Compaction.
func TestMutationsReopenAndCompaction(t *testing.T) {
	dir := t.TempDir()
	opts := Options{
		MaxMemTurns:    10,
		TierMergeWidth: 3,
		MaxSegments:    6,
	}
	idx, err := Open(dir, opts)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer idx.Close()

	ctx := context.Background()

	// Index 3 sessions across multiple small flushed segments.
	for s := 1; s <= 3; s++ {
		sid := fmt.Sprintf("sess-%d", s)
		if err := idx.UpdateSessionMeta(sid, fmt.Sprintf("OriginalHeadline%02d", s), "/proj", int64(1000+s)); err != nil {
			t.Fatal(err)
		}
		for turn := 0; turn < 12; turn++ {
			if err := idx.IndexTurn(TurnDoc{
				SessionID:            sid,
				TurnIndex:            turn,
				FirstMsgIdx:          turn * 2,
				BestUserOrAsstMsgIdx: turn*2 + 1,
				UpdatedAtUnix:        int64(2000 + turn),
				UserText:             fmt.Sprintf("userprompt%02ds%02d shared_corpus_token", turn, s),
				AssistantText:        fmt.Sprintf("asstanswer%02ds%02d detailed response", turn, s),
			}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := idx.Flush(); err != nil {
		t.Fatal(err)
	}

	// Verify HasSession reports maxTurnIndex == 11.
	maxT, ok := idx.HasSession("sess-1")
	if !ok || maxT != 11 {
		t.Fatalf("HasSession(sess-1) = (%d, %v), want (11, true)", maxT, ok)
	}
	if _, ok := idx.HasSession("non-existent"); ok {
		t.Fatalf("expected HasSession(non-existent) == false")
	}

	// Test O(1) Rename via UpdateSessionMeta without re-indexing turns!
	segsBefore := idx.Stats().SegmentCount
	if err := idx.UpdateSessionMeta("sess-1", "Renamed Quantum Hyperdrive", "/proj-new", 9999); err != nil {
		t.Fatalf("UpdateSessionMeta: %v", err)
	}
	if idx.Stats().SegmentCount != segsBefore {
		t.Fatalf("UpdateSessionMeta should not write turn segments: before=%d after=%d", segsBefore, idx.Stats().SegmentCount)
	}
	oldTitleHits, _ := idx.Search(ctx, Query{Text: "originalheadline01", DisablePrefix: true})
	for _, h := range oldTitleHits {
		if h.SessionID == "sess-1" {
			t.Fatalf("old title should no longer match sess-1 after rename")
		}
	}
	newTitleHits, err := idx.Search(ctx, Query{Text: "Quantum Hyperdrive", DisablePrefix: true})
	if err != nil || len(newTitleHits) != 1 || newTitleHits[0].SessionID != "sess-1" || newTitleHits[0].Field != "title" {
		t.Fatalf("expected sess-1 title hit after rename, got %+v (err=%v)", newTitleHits, err)
	}

	// Test idempotent replacement of existing turn (sess-1, turn 5).
	if err := idx.IndexTurn(TurnDoc{
		SessionID:            "sess-1",
		TurnIndex:            5,
		FirstMsgIdx:          10,
		BestUserOrAsstMsgIdx: 11,
		UpdatedAtUnix:        10005,
		UserText:             "replaced_turn_5_unique_payload shared_corpus_token",
		AssistantText:        "freshly regenerated answer",
	}); err != nil {
		t.Fatal(err)
	}
	if oldTurn, _ := idx.Search(ctx, Query{Text: "asstanswer05s01", DisablePrefix: true}); len(oldTurn) != 0 {
		t.Fatalf("old replaced turn text still matched: %+v", oldTurn)
	}
	repTurn, _ := idx.Search(ctx, Query{Text: "replaced_turn_5_unique_payload", DisablePrefix: true})
	if len(repTurn) != 1 || repTurn[0].MatchCount != 1 || repTurn[0].MessageIdx != 11 {
		t.Fatalf("expected 1 match at msgIdx=11 for replaced turn 5, got %+v", repTurn)
	}
	// Verify shared_corpus_token in sess-1 still has MatchCount == 12 (NOT 13 after replacing turn 5!).
	sharedHits, _ := idx.Search(ctx, Query{Text: "shared_corpus_token", DisablePrefix: true})
	for _, sh := range sharedHits {
		if sh.SessionID == "sess-1" && sh.MatchCount != 12 {
			t.Fatalf("expected MatchCount==12 on sess-1 after idempotent turn replace, got %d", sh.MatchCount)
		}
	}

	// Test TruncateSessionFromTurn on sess-2 (keep turns 0..4, drop 5..11).
	if err := idx.TruncateSessionFromTurn("sess-2", 5); err != nil {
		t.Fatalf("TruncateSessionFromTurn: %v", err)
	}
	maxT2, ok2 := idx.HasSession("sess-2")
	if !ok2 || maxT2 != 4 {
		t.Fatalf("HasSession(sess-2) after truncate(5) = (%d, %v), want (4, true)", maxT2, ok2)
	}
	if droppedHit, _ := idx.Search(ctx, Query{Text: "asstanswer07s02", DisablePrefix: true}); len(droppedHit) != 0 {
		t.Fatalf("truncated turn 7 still matched: %+v", droppedHit)
	}
	if keptHit, _ := idx.Search(ctx, Query{Text: "asstanswer04s02", DisablePrefix: true}); len(keptHit) != 1 {
		t.Fatalf("kept turn 4 missing after truncate: %+v", keptHit)
	}

	// Test DeleteSession on sess-3.
	if err := idx.DeleteSession("sess-3"); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, ok := idx.HasSession("sess-3"); ok {
		t.Fatalf("deleted sess-3 still reported by HasSession")
	}
	if delHit, _ := idx.Search(ctx, Query{Text: "asstanswer02s03", DisablePrefix: true}); len(delHit) != 0 {
		t.Fatalf("deleted sess-3 still matched: %+v", delHit)
	}

	// Close and reopen from disk: verify all tombstones, catalog renames, and turns survive!
	if err := idx.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	reopened, err := Open(dir, opts)
	if err != nil {
		t.Fatalf("Reopen: %v", err)
	}
	defer reopened.Close()

	stBefore := reopened.Stats()
	if stBefore.TombstoneDocs == 0 {
		t.Fatalf("expected tombstones on disk before Compact, got %+v", stBefore)
	}
	if stBefore.LiveDocs != 12+5 { // sess-1 has 12 live turns (0..11), sess-2 has 5 live turns (0..4)
		t.Fatalf("expected 17 live docs after reopen, got %d (%+v)", stBefore.LiveDocs, stBefore)
	}

	// Run Compact(ctx) and verify 100% of tombstones are physically stripped!
	if err := reopened.Compact(ctx); err != nil {
		t.Fatalf("Compact: %v", err)
	}
	stAfter := reopened.Stats()
	if stAfter.TombstoneDocs != 0 {
		t.Fatalf("expected 0 tombstones after Compact, got %d (%+v)", stAfter.TombstoneDocs, stAfter)
	}
	if stAfter.LiveDocs != 17 || stAfter.SegmentDocs != 17 {
		t.Fatalf("expected SegmentDocs == LiveDocs == 17 after Compact, got %+v", stAfter)
	}

	// Verify renamed title, replaced turn 5, kept turn 4, and deleted turns all behave identically post-compaction!
	if h, _ := reopened.Search(ctx, Query{Text: "Quantum Hyperdrive", DisablePrefix: true}); len(h) != 1 || h[0].Title != "Renamed Quantum Hyperdrive" {
		t.Fatalf("post-compact title search failed: %+v", h)
	}
	if h, _ := reopened.Search(ctx, Query{Text: "replaced_turn_5_unique_payload", DisablePrefix: true}); len(h) != 1 || h[0].MessageIdx != 11 {
		t.Fatalf("post-compact replaced turn search failed: %+v", h)
	}
	if h, _ := reopened.Search(ctx, Query{Text: "asstanswer02s03", DisablePrefix: true}); len(h) != 0 {
		t.Fatalf("post-compact deleted session resurrected: %+v", h)
	}
	if h, _ := reopened.Search(ctx, Query{Text: "asstanswer07s02", DisablePrefix: true}); len(h) != 0 {
		t.Fatalf("post-compact truncated turn resurrected: %+v", h)
	}
}

// 5. Context cancellation mid-query & concurrent read/write/compact safety.
func TestContextCancellationAndConcurrency(t *testing.T) {
	dir := t.TempDir()
	idx, err := Open(dir, Options{MaxMemTurns: 500})
	if err != nil {
		t.Fatal(err)
	}
	defer idx.Close()

	for s := 0; s < 20; s++ {
		sid := fmt.Sprintf("cancel-sess-%d", s)
		turns := make([]TurnDoc, 150)
		for i := range turns {
			turns[i] = TurnDoc{
				SessionID:            sid,
				TurnIndex:            i,
				FirstMsgIdx:          i * 2,
				BestUserOrAsstMsgIdx: i*2 + 1,
				UserText:             fmt.Sprintf("common_broad_term iteration %d session %d", i, s),
				AssistantText:        "common_broad_term detailed explanation across all turns",
			}
		}
		if err := idx.IndexSessionTurns(sid, SessionMeta{Title: sid, UpdatedAt: 1000}, turns); err != nil {
			t.Fatal(err)
		}
	}
	if err := idx.Flush(); err != nil {
		t.Fatal(err)
	}

	// Pre-cancelled context must return context.Canceled in < 0.2ms.
	cctx, cancel := context.WithCancel(context.Background())
	cancel()
	t0 := time.Now()
	_, err = idx.Search(cctx, Query{Text: "common_broad_term"})
	elapsed := time.Since(t0)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	if elapsed > 2*time.Millisecond {
		t.Fatalf("cancelled search took too long: %v", elapsed)
	}

	// Mid-flight cancellation while traversing multi-segment postings must cleanly return context.Canceled.
	sawMidCancel := false
	for attempt := 0; attempt < 200 && !sawMidCancel; attempt++ {
		mctx, mcancel := context.WithCancel(context.Background())
		go func(delay time.Duration) {
			time.Sleep(delay)
			mcancel()
		}(time.Duration(attempt%10) * 15 * time.Microsecond)
		_, mErr := idx.Search(mctx, Query{Text: "common_broad_term iteration detailed explanation"})
		mcancel()
		if errors.Is(mErr, context.Canceled) {
			sawMidCancel = true
		} else if mErr != nil {
			t.Fatalf("unexpected error on mid-query cancel: %v", mErr)
		}
	}
	if !sawMidCancel {
		t.Fatalf("expected at least one mid-query context.Canceled across attempts")
	}

	// Concurrent readers + writers + metadata updates + compaction stress check.
	var wg sync.WaitGroup
	stop := make(chan struct{})

	// 4 concurrent Search readers
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			queries := []string{"common_broad_term", "iteration", "explan", "cancel-sess"}
			step := 0
			for {
				select {
				case <-stop:
					return
				default:
				}
				q := queries[(id+step)%len(queries)]
				step++
				hits, sErr := idx.Search(context.Background(), Query{Text: q, Limit: 10})
				if sErr != nil {
					t.Errorf("concurrent Search(%q): %v", q, sErr)
					return
				}
				for _, h := range hits {
					if !utf8.ValidString(h.Snippet) {
						t.Errorf("invalid UTF-8 snippet during concurrency: %q", h.Snippet)
						return
					}
				}
			}
		}(r)
	}

	// Concurrent writer + renamer + compactor
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 60; i++ {
			sid := fmt.Sprintf("live-sess-%d", i%6)
			_ = idx.IndexTurn(TurnDoc{
				SessionID:            sid,
				TurnIndex:            i,
				FirstMsgIdx:          i * 3,
				BestUserOrAsstMsgIdx: i*3 + 2,
				UserText:             fmt.Sprintf("common_broad_term live turn %d", i),
				AssistantText:        "concurrent streaming indexing verification",
			})
			if i%10 == 0 {
				_ = idx.UpdateSessionMeta(sid, fmt.Sprintf("Live Session %d", i), "/cwd", int64(3000+i))
			}
			if i%20 == 0 {
				_ = idx.Compact(context.Background())
			}
		}
		close(stop)
	}()

	wg.Wait()
}

// 6. Scale Test (25,000 turns across 200 sessions including a 5,000-turn 1-year session) & BenchmarkSearch100k.
func TestScale100kTurns(t *testing.T) {
	dir := t.TempDir()
	idx, err := Open(dir, Options{
		MaxMemTurns:    2000,
		MaxMemBytes:    2 << 20,
		MaxSegments:    12,
		TierMergeWidth: 4,
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer idx.Close()

	vocab := []string{
		"postgres", "connection", "pool", "deadlock", "actor", "mailbox", "supervisor",
		"tailwind", "solidjs", "reactivity", "signaldb", "compaction", "zstd", "frame",
		"websocket", "relay", "failover", "anthropic", "streaming", "markdown", "diff",
		"sessão", "memória", "configuração", "latência", "execução", "processo", "árvore",
	}

	totalTurns := 0

	// Session 0: 5,000-turn "1-year marathon session" with a needle at Turn 3742 (msgIdx = 3742*3 + 2 = 11228)!
	yearTurns := make([]TurnDoc, 5000)
	for ti := 0; ti < 5000; ti++ {
		w1 := vocab[ti%len(vocab)]
		w2 := vocab[(ti*7+3)%len(vocab)]
		uTxt := fmt.Sprintf("Investigating %s behaviour in SessionActor turn %d with store_wal.go", w1, ti)
		aTxt := fmt.Sprintf("Verified %s and %s handling inside cmd/daemon/turn_history.go:%d", w1, w2, (ti%400)+1)
		if ti == 3742 {
			aTxt = "Resolved needle_marathon_3742_heisenbug inside packages/searchindex/query.go:210 with zero allocations!"
		}
		yearTurns[ti] = TurnDoc{
			SessionID:            "sess-1year-5000",
			TurnIndex:            ti,
			FirstMsgIdx:          ti * 3,
			BestUserOrAsstMsgIdx: ti*3 + 2,
			UpdatedAtUnix:        int64(1700000000 + ti*60),
			UserText:             uTxt,
			AssistantText:        aTxt,
			ToolText:             fmt.Sprintf("bash go test ./packages/%s/...", w1),
			HasFieldMsgIdx:       true,
			UserMsgIdx:           ti * 3,
			ToolMsgIdx:           ti*3 + 1,
			AssistantMsgIdx:      ti*3 + 2,
		}
	}
	if err := idx.IndexSessionTurns("sess-1year-5000", SessionMeta{
		Title:     "One-Year Architecture Marathon",
		CWD:       "/workspace/indirect",
		UpdatedAt: 1700300000,
	}, yearTurns); err != nil {
		t.Fatalf("index 5k session: %v", err)
	}
	totalTurns += len(yearTurns)
	yearTurns = nil // release fixture slice before measuring index RAM

	// Sessions 1..199: 199 sessions * 101 turns = 20,099 turns -> total 25,099 turns across 200 sessions!
	for s := 1; s < 200; s++ {
		sid := fmt.Sprintf("sess-%03d", s)
		turns := make([]TurnDoc, 101)
		for ti := 0; ti < 101; ti++ {
			vIdx := (s*13 + ti*5) % len(vocab)
			w1 := vocab[vIdx]
			w2 := vocab[(vIdx+9)%len(vocab)]
			turns[ti] = TurnDoc{
				SessionID:            sid,
				TurnIndex:            ti,
				FirstMsgIdx:          ti * 2,
				BestUserOrAsstMsgIdx: ti*2 + 1,
				UpdatedAtUnix:        int64(1690000000 + s*1000 + ti),
				UserText:             fmt.Sprintf("How to tune %s and %s in module_%d?", w1, w2, s%25),
				AssistantText:        fmt.Sprintf("Configured %s pipeline for service_%d with clean shutdown.", w1, s),
				ToolText:             fmt.Sprintf("read internal/service_%d/handler.go", s),
			}
		}
		if err := idx.IndexSessionTurns(sid, SessionMeta{
			Title:     fmt.Sprintf("Project Service %d (%s)", s, vocab[s%len(vocab)]),
			CWD:       fmt.Sprintf("/workspace/proj-%d", s%10),
			UpdatedAt: int64(1690000000 + s*1000 + 101),
		}, turns); err != nil {
			t.Fatalf("index %s: %v", sid, err)
		}
		totalTurns += len(turns)
	}

	if err := idx.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if err := idx.Compact(context.Background()); err != nil {
		t.Fatalf("Compact: %v", err)
	}

	runtime.GC()
	st := idx.Stats()
	t.Logf("Scale stats: sessions=%d liveDocs=%d segments=%d dictLeaders=%d dictLeadersRAM=%dB estimatedRAM=%.2f MiB",
		st.Sessions, st.LiveDocs, st.SegmentCount, st.DictLeaders, st.DictLeadersRAM, float64(st.EstimatedRAM)/(1024*1024))

	if st.LiveDocs != totalTurns {
		t.Fatalf("expected %d live docs, got %d", totalTurns, st.LiveDocs)
	}
	if st.SegmentCount > 12 {
		t.Fatalf("expected <=12 segments, got %d", st.SegmentCount)
	}
	if st.EstimatedRAM > 12<<20 {
		t.Fatalf("index RAM %.2f MiB exceeded 12 MiB budget", float64(st.EstimatedRAM)/(1024*1024))
	}

	ctx := context.Background()

	// 1. Needle in 5,000-turn session must resolve exact TurnIndex=3742 and MessageIdx=11228 in < 15ms!
	t0 := time.Now()
	needleHits, err := idx.Search(ctx, Query{Text: "needle_marathon_3742_heisenbug", Limit: 30})
	needleDur := time.Since(t0)
	if err != nil {
		t.Fatalf("needle search: %v", err)
	}
	if len(needleHits) != 1 || needleHits[0].SessionID != "sess-1year-5000" {
		t.Fatalf("expected needle hit in sess-1year-5000, got %+v", needleHits)
	}
	if needleHits[0].TurnIndex != 3742 || needleHits[0].MessageIdx != 3742*3+2 {
		t.Fatalf("expected TurnIndex=3742 MessageIdx=%d, got TurnIndex=%d MessageIdx=%d",
			3742*3+2, needleHits[0].TurnIndex, needleHits[0].MessageIdx)
	}
	if needleDur > 15*time.Millisecond {
		t.Fatalf("needle search exceeded 15ms: %v", needleDur)
	}

	// 2. Broad multi-term, PT-BR diacritic, code token, and live prefix queries must all finish in < 15ms!
	scaleQueries := []string{
		"postgres deadlock",
		"configuracao memoria",
		"SessionActor store_wal.go",
		"websocket compac",
		"One-Year Architecture",
	}
	for _, sq := range scaleQueries {
		// Warm + measure
		start := time.Now()
		hits, err := idx.Search(ctx, Query{Text: sq, Limit: 30})
		dur := time.Since(start)
		if err != nil {
			t.Fatalf("Search(%q): %v", sq, err)
		}
		if len(hits) == 0 {
			t.Fatalf("expected hits for %q", sq)
		}
		t.Logf("Query %q -> %d results in %v (top=%s score=%.2f msgIdx=%d)",
			sq, len(hits), dur, hits[0].SessionID, hits[0].Score, hits[0].MessageIdx)
		if dur > 15*time.Millisecond {
			t.Fatalf("Query %q took %v (exceeds 15ms budget)", sq, dur)
		}
	}
}

func BenchmarkSearch100k(b *testing.B) {
	dir := b.TempDir()
	idx, err := Open(dir, Options{
		MaxMemTurns:    4000,
		MaxMemBytes:    4 << 20,
		MaxSegments:    12,
		TierMergeWidth: 4,
	})
	if err != nil {
		b.Fatal(err)
	}
	defer idx.Close()

	words := []string{
		"postgres", "sqlite", "wal", "compaction", "zstd", "bm25", "tokenizer",
		"solidjs", "tailwind", "websocket", "actor", "supervisor", "proctable",
		"sessão", "memória", "configuração", "latência", "autenticação", "gateway",
		"failover", "anthropic", "streaming", "diff", "sandbox", "quickjs",
	}

	// Populate 100,000 turns across 500 sessions (200 turns/session).
	const numSessions = 500
	const turnsPerSession = 200
	turns := make([]TurnDoc, turnsPerSession)
	for s := 0; s < numSessions; s++ {
		sid := fmt.Sprintf("bench-sess-%04d", s)
		for t := 0; t < turnsPerSession; t++ {
			w1 := words[(s*7+t*3)%len(words)]
			w2 := words[(s*11+t*5+1)%len(words)]
			w3 := words[(s*17+t*2+4)%len(words)]
			turns[t] = TurnDoc{
				SessionID:            sid,
				TurnIndex:            t,
				FirstMsgIdx:          t * 2,
				BestUserOrAsstMsgIdx: t*2 + 1,
				UpdatedAtUnix:        int64(1700000000 + s*500 + t),
				UserText:             fmt.Sprintf("Optimize %s and %s in handler_%d.go", w1, w2, (s+t)%64),
				AssistantText:        fmt.Sprintf("Updated %s implementation with %s metrics in TurnWorker", w2, w3),
				ToolText:             fmt.Sprintf("bash go test ./internal/mod_%d", s%32),
			}
		}
		if err := idx.IndexSessionTurns(sid, SessionMeta{
			Title:     fmt.Sprintf("Session %d: %s & %s", s, words[s%len(words)], words[(s+5)%len(words)]),
			CWD:       "/bench/repo",
			UpdatedAt: int64(1700000000 + s*500 + turnsPerSession),
		}, turns); err != nil {
			b.Fatal(err)
		}
	}
	if err := idx.Flush(); err != nil {
		b.Fatal(err)
	}
	if err := idx.Compact(context.Background()); err != nil {
		b.Fatal(err)
	}

	st := idx.Stats()

	queries := []Query{
		{Text: "postgres failover", Limit: 30},
		{Text: "configuracao latencia", Limit: 30},
		{Text: "TurnWorker compac", Limit: 30},
		{Text: "handler_42.go", Limit: 30},
	}

	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		hits, err := idx.Search(ctx, queries[i%len(queries)])
		if err != nil {
			b.Fatal(err)
		}
		if len(hits) == 0 {
			b.Fatal("expected non-empty hits")
		}
	}
	b.StopTimer()
	b.ReportMetric(float64(st.EstimatedRAM)/(1024*1024), "ram_MiB")
	b.ReportMetric(float64(st.SegmentCount), "segments")
}
