package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"indirect/indirect-code-daemon/packages/agent/tools"
	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"
)

func seedMultiEraCompaction() *core.CompactionState {
	st := &core.CompactionState{
		Count:        2,
		NextBlockSeq: 2,
		PrunedBefore: 4,
		Blocks: []core.FoldBlock{
			{
				ID:            "b1",
				Tier:          1,
				StartIdx:      0,
				EndIdx:        2,
				Topic:         "Era one setup",
				Summary:       "## Goal\n- Set up era one with CONST_ALPHA_901.",
				ReadFiles:     []string{"pkg/alpha.go"},
				ModifiedFiles: []string{"pkg/config.go"},
				FailedCommands: []core.FailedCommandSummary{
					{Command: "go test ./pkg/...", ExitCode: "1", FirstError: "undefined: AlphaInit"},
				},
			},
			{
				ID:            "b2",
				Tier:          1,
				StartIdx:      2,
				EndIdx:        4,
				Topic:         "Era two refactor",
				Summary:       "## Goal\n- Refactored era two.",
				ReadFiles:     []string{"pkg/beta.go"},
				ModifiedFiles: []string{"pkg/beta.go"},
			},
		},
	}
	st.SyncMirrors()
	return st
}

// TestLSMActorFiveTruncationPaths verifies granular FoldBlock rollback across
// all 5 session history cut/edit/fork paths:
//  1. applyDiscardAndResend
//  2. onTruncateAndRun
//  3. onFork
//  4. onEditApply (fixing immediate message-swallow at m.Index == KeepFrom-1)
//  5. onEditRegenerate (fixing delayed KeepFrom time-bomb + Tier-2 un-retire)
func TestLSMActorFiveTruncationPaths(t *testing.T) {
	t.Run("1_discard_and_resend_preserves_b1_drops_b2", func(t *testing.T) {
		// 6 messages: Turn 1=[0,2), Turn 2=[2,4), Turn 3=[4,6).
		// Discarding Turn 2 cuts at idx=2 -> drops b2 ([2,4)), keeps b1 ([0,2))!
		rec := &SessionRecord{
			ID:         "lsm-dar",
			Messages:   darMsgs(6),
			TurnSeq:    3,
			Compaction: seedMultiEraCompaction(),
		}
		a, st := darActor(t, rec)
		reply := make(chan any, 1)
		a.onDiscardAndResend(discardAndResendMsg{TurnID: 2, Text: "rewritten turn 2", Reply: reply})
		if r := (<-reply).(discardResendResult); r.Error != "" {
			t.Fatalf("discard_and_resend failed: %s", r.Error)
		}
		if a.rec.Compaction == nil {
			t.Fatal("expected b1 ([0,2)) to survive discard at idx=2, got nil")
		}
		active := a.rec.Compaction.ActiveBlocks()
		if len(active) != 1 || active[0].ID != "b1" || a.rec.Compaction.KeepFrom != 2 {
			t.Fatalf("expected active=[b1] KeepFrom=2, got active=%+v KeepFrom=%d", active, a.rec.Compaction.KeepFrom)
		}
		// Verify seeded prompt at index 2 is NOT swallowed by projection!
		ag := core.NewAgent(nil, "m", "", nil)
		ag.SetMessages(a.rec.Messages)
		ag.SeedCompactionState(a.rec.Compaction)
		projected := ag.Messages()
		if len(projected) != 2 || !strings.Contains(contentText(projected[1]), "rewritten turn 2") {
			t.Fatalf("projected context must be [syn(b1), rewritten turn 2], got %+v", projected)
		}
		fused, _, err := st.loadSessionFused("lsm-dar")
		if err != nil {
			t.Fatal(err)
		}
		if fused.Compaction == nil || fused.Compaction.KeepFrom != 2 || len(fused.Compaction.ActiveBlocks()) != 1 {
			t.Fatalf("disk compaction drifted: %+v", fused.Compaction)
		}
	})

	t.Run("2_truncate_and_run_preserves_b1_drops_b2", func(t *testing.T) {
		rec := &SessionRecord{
			ID:         "lsm-tar",
			Messages:   darMsgs(6),
			TurnSeq:    3,
			Compaction: seedMultiEraCompaction(),
		}
		a, _ := darActor(t, rec)
		reply := make(chan any, 1)
		a.onTruncateAndRun(truncateAndRunMsg{Keep: 2, Text: "truncated turn 2", Reply: reply})
		if r := (<-reply).(truncateRunResult); r.Error != "" {
			t.Fatalf("truncate_and_run failed: %s", r.Error)
		}
		if a.rec.Compaction == nil || a.rec.Compaction.KeepFrom != 2 {
			t.Fatalf("expected KeepFrom=2 after Keep=2 truncate, got %+v", a.rec.Compaction)
		}
		active := a.rec.Compaction.ActiveBlocks()
		if len(active) != 1 || active[0].ID != "b1" {
			t.Fatalf("expected [b1], got %+v", active)
		}
	})

	t.Run("3_fork_at_turn_1_preserves_b1_drops_b2", func(t *testing.T) {
		rec := &SessionRecord{
			ID:         "lsm-fork-src",
			Title:      "Main",
			Messages:   darMsgs(6),
			TurnSeq:    3,
			Compaction: seedMultiEraCompaction(),
		}
		a, st := darActor(t, rec)
		reply := make(chan any, 1)
		// Keep: 0 -> Turn 1 is [0, 2), so end = 2!
		a.onFork(forkReqMsg{NewID: "sess_fork_target1", Keep: 0, Reply: reply})
		fr := (<-reply).(forkResult)
		if fr.Error != "" {
			t.Fatalf("onFork failed: %s", fr.Error)
		}
		forked, err := st.loadSession(fr.NewID)
		if err != nil {
			t.Fatal(err)
		}
		if forked.Compaction == nil {
			t.Fatal("fork lost b1 compaction block when forking below b2")
		}
		active := forked.Compaction.ActiveBlocks()
		if len(active) != 1 || active[0].ID != "b1" || forked.Compaction.KeepFrom != 2 {
			t.Fatalf("fork compaction = %+v, want [b1] KeepFrom=2", forked.Compaction)
		}
		// Source session remains completely untouched with [b1, b2].
		if len(a.rec.Compaction.ActiveBlocks()) != 2 {
			t.Fatalf("source session mutated by fork: %+v", a.rec.Compaction)
		}
	})

	t.Run("4_edit_apply_fixes_immediate_message_swallow_and_keeps_b1", func(t *testing.T) {
		// Regression for immediate swallow bug:
		// KeepFrom == 4 ([b1:[0,2), b2:[2,4)]). Editing user message at Index=2
		// (or Index=3 if user) mutates Messages[Index] and cuts to len=Index+1.
		// Without TruncateCompaction(c, Index), editing Index=2 (or KeepFrom-1)
		// left stale b2/KeepFrom hiding the edited message!
		msgs := darMsgs(6)
		// Make Index=3 a user message as well so Index == KeepFrom-1 (3 == 4-1) is directly tested!
		msgs[3] = provider.Message{
			ID: "u-idx3", Role: provider.RoleUser, TurnIndex: 2,
			Content: []provider.Content{provider.TextBlock{Text: "before edit"}},
		}
		rec := &SessionRecord{
			ID:         "lsm-edit-apply",
			Messages:   msgs,
			TurnSeq:    3,
			Compaction: seedMultiEraCompaction(),
		}
		a, _ := darActor(t, rec)
		res := a.onEditApply(editApplyMsg{Index: 3, Text: "NEWLY EDITED AT KEEPFROM MINUS ONE"})
		if res.Error != "" {
			t.Fatalf("onEditApply failed: %s", res.Error)
		}
		// b2 ([2,4)) straddled Index=3 so b2 MUST be dropped, while b1 ([0,2)) MUST survive!
		if a.rec.Compaction == nil {
			t.Fatal("expected b1 to survive edit at Index=3")
		}
		active := a.rec.Compaction.ActiveBlocks()
		if len(active) != 1 || active[0].ID != "b1" || a.rec.Compaction.KeepFrom != 2 {
			t.Fatalf("expected [b1] KeepFrom=2, got active=%+v KeepFrom=%d", active, a.rec.Compaction.KeepFrom)
		}
		ag := core.NewAgent(nil, "m", "", nil)
		ag.SetMessages(a.rec.Messages)
		ag.SeedCompactionState(a.rec.Compaction)
		projected := ag.Messages()
		foundEdited := false
		for _, pm := range projected {
			if strings.Contains(contentText(pm), "NEWLY EDITED AT KEEPFROM MINUS ONE") {
				foundEdited = true
			}
		}
		if !foundEdited {
			t.Fatalf("newly edited message at KeepFrom-1 was swallowed by stale compaction! projected=%+v", projected)
		}
	})

	t.Run("5_edit_regenerate_fixes_time_bomb_and_unretires_tier2_children", func(t *testing.T) {
		// Seed a Tier-2 rollup b3 ([0, 4)) that retired Tier-1 b1 ([0, 2)) and b2 ([2, 4)).
		tier2State := &core.CompactionState{
			Count:        3,
			NextBlockSeq: 3,
			PrunedBefore: 4,
			Blocks: []core.FoldBlock{
				{ID: "b1", Tier: 1, StartIdx: 0, EndIdx: 2, Summary: "era 1", RetiredByBlockID: "b3"},
				{ID: "b2", Tier: 1, StartIdx: 2, EndIdx: 4, Summary: "era 2", RetiredByBlockID: "b3"},
				{ID: "b3", Tier: 2, StartIdx: 0, EndIdx: 4, Summary: "merged eras 1+2", SourceBlockIDs: []string{"b1", "b2"}},
			},
		}
		tier2State.SyncMirrors()
		rec := &SessionRecord{
			ID:         "lsm-edit-regen",
			Messages:   darMsgs(6),
			TurnSeq:    3,
			Compaction: tier2State,
		}
		a, _ := darActor(t, rec)
		reply := make(chan any, 1)
		// Cut at Keep=2: drops b3 ([0,4)) AND b2 ([2,4)), un-retiring b1 ([0,2))!
		a.onEditRegenerate(editRegenerateMsg{Keep: 2, Reply: reply})
		pr := (<-reply).(promptResult)
		if pr.Error != "" || !pr.Accepted {
			t.Fatalf("onEditRegenerate failed: %+v", pr)
		}
		if a.rec.Compaction == nil {
			t.Fatal("expected un-retired b1 to survive Keep=2 regenerate")
		}
		active := a.rec.Compaction.ActiveBlocks()
		if len(active) != 1 || active[0].ID != "b1" || a.rec.Compaction.KeepFrom != 2 {
			t.Fatalf("expected un-retired [b1] KeepFrom=2, got active=%+v KeepFrom=%d", active, a.rec.Compaction.KeepFrom)
		}
		// Append 3 new turns so len(Messages) grows past old KeepFrom=4:
		// must NOT swallow new messages [2..] into stale b3!
		a.rec.Messages = append(a.rec.Messages,
			provider.Message{ID: "n2", Role: provider.RoleUser, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "post-regen-u2"}}},
			provider.Message{ID: "n3", Role: provider.RoleAssistant, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "post-regen-a2"}}},
			provider.Message{ID: "n4", Role: provider.RoleUser, TurnIndex: 3, Content: []provider.Content{provider.TextBlock{Text: "post-regen-u3"}}},
		)
		ag := core.NewAgent(nil, "m", "", nil)
		ag.SetMessages(a.rec.Messages)
		ag.SeedCompactionState(a.rec.Compaction)
		projected := ag.Messages()
		if !strings.Contains(contentText(projected[1]), "post-regen-u2") {
			t.Fatalf("time-bomb swallowed post-regen message! projected=%+v", projected)
		}
	})
}

func TestFinishTurnShiftsMultiBlockCompactionIndicesOnSkillStrip(t *testing.T) {
	// Pre-strip transcript (9 messages, Turn 2 starts at idx 2):
	// 0: u1 (Turn 1)
	// 1: a1 (Turn 1)
	// 2: u2 (Turn 2)
	// 3: a2 use_skill (Turn 2 - DROPPED)
	// 4: t2 use_skill result (Turn 2 - DROPPED)
	// 5: a3 real step (Turn 2 - KEPT)
	// 6: n2 skill notice (Turn 2 - DROPPED)
	// 7: a4 kept tail (Turn 2 - KEPT)
	// 8: u4 kept tail (Turn 2 - KEPT)
	//
	// Pre-strip blocks:
	//   b1: [0, 2) -> stays [0, 2)
	//   b2: [2, 7) (covering u2, dropped a2, dropped t2, kept a3, dropped n2) -> MUST shift to [2, 4)!
	//   KeepFrom: 7 -> MUST shift to 4!
	//   PrunedBefore: 6 -> MUST shift to 4!
	comp := &core.CompactionState{
		Count:        2,
		NextBlockSeq: 2,
		KeepFrom:     7,
		PrunedBefore: 6,
		Blocks: []core.FoldBlock{
			{ID: "b1", Tier: 1, StartIdx: 0, EndIdx: 2, Summary: "turn 1"},
			{ID: "b2", Tier: 1, StartIdx: 2, EndIdx: 7, Summary: "turn 2 prefix"},
		},
	}
	rec := &SessionRecord{
		ID:         "skill-shift-blocks",
		TurnSeq:    2,
		Compaction: comp,
		Messages: []provider.Message{
			{ID: "u1", Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "u1"}}},
			{ID: "a1", Role: provider.RoleAssistant, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "a1"}}},
			{ID: "u2", Role: provider.RoleUser, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "u2"}}},
			{ID: "a2", Role: provider.RoleAssistant, TurnIndex: 2, Content: []provider.Content{
				provider.ReasoningBlock{Summary: "load skill"},
				provider.ToolCallBlock{ID: "sk1", Name: "use_skill"},
			}},
			{ID: "t2", Role: provider.RoleTool, TurnIndex: 2, Content: []provider.Content{
				provider.ToolResultBlock{CallID: "sk1", Details: map[string]any{"skill": "demo"}},
			}},
			{ID: "a3", Role: provider.RoleAssistant, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "a3"}}},
			{ID: "n2", Role: provider.RoleUser, TurnIndex: 2, Meta: map[string]string{skillNoticeMetaKey: "demo"}, Content: []provider.Content{
				provider.TextBlock{Text: "[system notice] skill deactivated"},
			}},
			{ID: "a4", Role: provider.RoleAssistant, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "a4"}}},
			{ID: "u4", Role: provider.RoleUser, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "u4"}}},
		},
	}
	a, _ := darActor(t, rec)
	a.finishTurn(true)

	if len(a.rec.Messages) != 6 {
		t.Fatalf("len(Messages) = %d, want 6", len(a.rec.Messages))
	}
	if a.rec.Compaction == nil {
		t.Fatal("compaction lost")
	}
	active := a.rec.Compaction.ActiveBlocks()
	if len(active) != 2 {
		t.Fatalf("active blocks = %+v, want 2", active)
	}
	if active[0].StartIdx != 0 || active[0].EndIdx != 2 {
		t.Fatalf("b1 span = [%d,%d), want [0,2)", active[0].StartIdx, active[0].EndIdx)
	}
	if active[1].StartIdx != 2 || active[1].EndIdx != 4 {
		t.Fatalf("b2 span = [%d,%d), want [2,4)", active[1].StartIdx, active[1].EndIdx)
	}
	if a.rec.Compaction.KeepFrom != 4 {
		t.Fatalf("KeepFrom = %d, want 4", a.rec.Compaction.KeepFrom)
	}
	if a.rec.Compaction.PrunedBefore != 4 {
		t.Fatalf("PrunedBefore = %d, want 4", a.rec.Compaction.PrunedBefore)
	}
}

type noopStreamClient struct {
	calls int
}

func (c *noopStreamClient) Name() string { return "anthropic" }

func (c *noopStreamClient) Stream(_ context.Context, _ provider.Request) (<-chan provider.Event, error) {
	c.calls++
	ch := make(chan provider.Event, 2)
	msg := provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "## Goal\n- Compacted."}}}
	ch <- provider.EventDone{Message: msg}
	close(ch)
	return ch, nil
}

func TestAutoCompactThresholdOffSkipsProactiveCompaction(t *testing.T) {
	client := &noopStreamClient{}
	ag := core.NewAgent(client, "m", "sys", core.NewRegistry())
	var msgs []provider.Message
	for i := 0; i < 8; i++ {
		msgs = append(msgs,
			provider.Message{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: strings.Repeat("heavy user prompt ", 800)}}},
			provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: strings.Repeat("heavy assistant reply ", 800)}}},
		)
	}
	ag.SetMessages(msgs)

	var cfgCell configCell
	cfgCell.store(&DaemonConfig{Settings: HarnessSettings{AutoCompactThreshold: 0}})
	w := &turnBridge{
		ctx:       context.Background(),
		cfg:       DaemonConfig{Settings: HarnessSettings{AutoCompactThreshold: 0}},
		env:       workerEnv{cfg: &cfgCell},
		modelInfo: provider.Model{ID: "m", ContextWindow: 8000},
		agent:     ag,
	}
	if err := w.autoCompact(context.Background(), func(core.AgentEvent) {}); err != nil {
		t.Fatalf("autoCompact returned error when Off: %v", err)
	}
	if client.calls != 0 || ag.CompactionChain() != nil {
		t.Fatalf("AutoCompactThreshold=0 ('Off') must NOT trigger proactive compaction: calls=%d chain=%+v", client.calls, ag.CompactionChain())
	}

	// Enabling threshold=70 on the live config cell triggers proactive compaction!
	cfgCell.store(&DaemonConfig{Settings: HarnessSettings{AutoCompactThreshold: 70}})
	if err := w.autoCompact(context.Background(), func(core.AgentEvent) {}); err != nil {
		t.Fatalf("autoCompact with threshold=70 failed: %v", err)
	}
	if client.calls == 0 || ag.CompactionChain() == nil {
		t.Fatalf("expected proactive compaction when AutoCompactThreshold=70, calls=%d", client.calls)
	}
}

func TestSessionHistorySnapshotAndCompactedFileAdvisoryWiring(t *testing.T) {
	cwd := t.TempDir()
	brainDir := t.TempDir()
	alphaPath := filepath.Join(cwd, "pkg", "alpha.go")
	configPath := filepath.Join(cwd, "pkg", "config.go")
	if err := os.MkdirAll(filepath.Dir(alphaPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("package pkg\nconst Port = 8080\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	rawMsgs := []provider.Message{
		{Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "Set secret CONST_NEEDLE_77819 in pkg/config.go"}}},
		{Role: provider.RoleAssistant, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "Done setting CONST_NEEDLE_77819."}}},
		{Role: provider.RoleUser, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "Refactor beta"}}},
		{Role: provider.RoleAssistant, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "Refactored beta."}}},
		// Live tail [4:]: reads pkg/alpha.go, leaves pkg/config.go unread!
		{Role: provider.RoleUser, TurnIndex: 3, Content: []provider.Content{provider.TextBlock{Text: "Check alpha"}}},
		{Role: provider.RoleAssistant, TurnIndex: 3, Content: []provider.Content{
			provider.ToolCallBlock{ID: "rc1", Name: "read", Arguments: json.RawMessage(`{"path":"pkg/alpha.go"}`)},
		}},
		{Role: provider.RoleTool, TurnIndex: 3, Content: []provider.Content{
			provider.ToolResultBlock{CallID: "rc1", Content: []provider.Content{provider.TextBlock{Text: "package pkg\n"}}},
		}},
	}

	ag := core.NewAgent(nil, "m", "sys", core.NewRegistry())
	ag.SetMessages(rawMsgs)
	ag.SeedCompactionState(seedMultiEraCompaction())

	w := &turnBridge{
		ctx:        context.Background(),
		sessionCWD: cwd,
		brainDir:   brainDir,
		agent:      ag,
	}

	// 1. SessionHistoryTool search & verbatim recall through turnBridge.sessionHistorySnapshot.
	shTool := &tools.SessionHistoryTool{Source: w.sessionHistorySnapshot}
	searchRes, err := shTool.Execute(context.Background(), json.RawMessage(`{"action":"search","query":"CONST_NEEDLE_77819"}`), nil)
	if err != nil {
		t.Fatalf("session_history search failed: %v", err)
	}
	searchText := contentText(provider.Message{Content: searchRes.Content})
	if !strings.Contains(searchText, "CONST_NEEDLE_77819") || !strings.Contains(searchText, "b1") {
		t.Fatalf("expected BM25 hit on CONST_NEEDLE_77819 in b1, got:\n%s", searchText)
	}

	recallRes, err := shTool.Execute(context.Background(), json.RawMessage(`{"action":"recall","block_id":"b1"}`), nil)
	if err != nil {
		t.Fatalf("session_history recall failed: %v", err)
	}
	recallText := contentText(provider.Message{Content: recallRes.Content})
	if !strings.Contains(recallText, "Set secret CONST_NEEDLE_77819 in pkg/config.go") {
		t.Fatalf("expected verbatim Turn-1 message in recall(b1), got:\n%s", recallText)
	}

	// 2. CompactedFileAdvisory:
	// - pkg/config.go was modified in b1 and NOT read in live tail [4:] -> returns concise b1 advisory!
	advConfig := w.compactedFileAdvisory(configPath)
	if !strings.Contains(advConfig, "b1") || !strings.Contains(advConfig, "modified") {
		t.Fatalf("expected b1 modified advisory for unread pkg/config.go, got %q", advConfig)
	}
	// - pkg/alpha.go WAS read in live tail [4:] -> returns "" (zero false-positive noise)!
	if advAlpha := w.compactedFileAdvisory(alphaPath); advAlpha != "" {
		t.Fatalf("expected empty advisory when pkg/alpha.go was already read in live tail, got %q", advAlpha)
	}
	// - Untouched file -> returns ""!
	if advOther := w.compactedFileAdvisory(filepath.Join(cwd, "pkg", "untouched.go")); advOther != "" {
		t.Fatalf("expected empty advisory for untouched file, got %q", advOther)
	}
}

func TestSubagentUsageAccumulatesIntoAgentCostAndWAL(t *testing.T) {
	rec := &SessionRecord{ID: "sub-usage", Messages: darMsgs(2), TurnSeq: 1}
	a, _ := darActor(t, rec)
	a.gen = 1
	a.state = stateRunning
	wal, err := a.store.openWAL(a.id, &walHeader{TurnIndex: 1, Prompt: "go"})
	if err != nil {
		t.Fatal(err)
	}
	a.wal = wal

	ag := core.NewAgent(nil, "m", "sys", core.NewRegistry())
	ag.SeedCost(provider.Usage{InputTokens: 1000, OutputTokens: 200, CostUSD: 0.01})

	w := &turnBridge{
		ctx:       context.Background(),
		snap:      workerSnapshot{gen: 1, epoch: a.epoch, turnIndex: 1},
		env:       workerEnv{inbox: a.inbox, done: a.done, actorID: a.id},
		modelInfo: provider.Model{ID: "m", ContextWindow: 128000},
		agent:     ag,
	}
	w.onSubagentUsage(provider.Usage{InputTokens: 450, OutputTokens: 120, CostUSD: 0.005})

	gotCost := ag.Cost()
	if gotCost.InputTokens != 1450 || gotCost.OutputTokens != 320 {
		t.Fatalf("agent Cost() = %+v, want InputTokens=1450 OutputTokens=320", gotCost)
	}
	// Drain inbox messages (skipping worker heartbeats) into actor to verify WAL/SessionRecord Usage updates.
	var wMsg walAppendMsg
	for {
		env := <-a.inbox
		if _, isHB := env.Payload.(workerHeartbeatMsg); isHB {
			continue
		}
		var ok bool
		wMsg, ok = env.Payload.(walAppendMsg)
		if !ok {
			t.Fatalf("expected walAppendMsg on inbox, got %T", env.Payload)
		}
		break
	}
	a.onWALAppend(wMsg)
	if a.rec.Usage.InputTokens != 1450 || a.rec.Usage.OutputTokens != 320 {
		t.Fatalf("actor rec.Usage = %+v, want InputTokens=1450 OutputTokens=320", a.rec.Usage)
	}
	if last := ag.LastTurnUsage(); last.InputTokens != 450 || last.OutputTokens != 120 {
		t.Fatalf("agent LastTurnUsage() = %+v, want InputTokens=450 OutputTokens=120", last)
	}
}

func TestLegacySingleSummaryOnForkClearsBelowKeepFromAndPreservesAtOrAbove(t *testing.T) {
	legacyComp := &core.CompactionState{
		PreviousSummary: "LEGACY_SUMMARY_TURNS_1_AND_2_SECRET_FUTURE",
		ReadFiles:       []string{"pkg/legacy.go"},
		KeepFrom:        4, // summarized raw [0, 4): Turn 1 ([0,2)) + Turn 2 ([2,4))
		Count:           1,
	}
	rec := &SessionRecord{
		ID:         "legacy-fork-src",
		Title:      "LegacyMain",
		Messages:   darMsgs(6), // Turn 1=[0,2), Turn 2=[2,4), Turn 3=[4,6)
		TurnSeq:    3,
		Compaction: legacyComp,
	}
	a, st := darActor(t, rec)

	// 1. Forking at Turn 1 (Keep=1 -> end=2 < KeepFrom=4) MUST clear Compaction
	// so discarded Turn-2 details never leak into the fork and Turn-1 raw rows stay visible!
	repBelow := make(chan any, 1)
	a.onFork(forkReqMsg{NewID: "sess_legacy_fork_below", Keep: 1, Reply: repBelow})
	frBelow := (<-repBelow).(forkResult)
	if frBelow.Error != "" {
		t.Fatalf("onFork below KeepFrom failed: %s", frBelow.Error)
	}
	forkBelow, err := st.loadSession(frBelow.NewID)
	if err != nil {
		t.Fatal(err)
	}
	if forkBelow.Compaction != nil {
		t.Fatalf("legacy single-summary compaction leaked across end < KeepFrom fork: %+v", forkBelow.Compaction)
	}
	agBelow := core.NewAgent(nil, "m", "", nil)
	agBelow.SetMessages(forkBelow.Messages)
	agBelow.SeedCompactionState(forkBelow.Compaction)
	projBelow := agBelow.Messages()
	if len(projBelow) != 2 {
		t.Fatalf("expected 2 visible raw Turn-1 messages, got %d", len(projBelow))
	}
	for _, m := range projBelow {
		if strings.Contains(contentText(m), "LEGACY_SUMMARY_TURNS_1_AND_2_SECRET_FUTURE") {
			t.Fatalf("hallucinated future summary leaked into fork: %+v", m)
		}
	}

	// 2. Forking at Turn 2 (Keep=3 -> end=4 == KeepFrom=4) MUST preserve legacy Compaction cleanly!
	repAt := make(chan any, 1)
	a.onFork(forkReqMsg{NewID: "sess_legacy_fork_at", Keep: 3, Reply: repAt})
	frAt := (<-repAt).(forkResult)
	if frAt.Error != "" {
		t.Fatalf("onFork at KeepFrom failed: %s", frAt.Error)
	}
	forkAt, err := st.loadSession(frAt.NewID)
	if err != nil {
		t.Fatal(err)
	}
	if forkAt.Compaction == nil || forkAt.Compaction.KeepFrom != 4 || forkAt.Compaction.PreviousSummary != legacyComp.PreviousSummary {
		t.Fatalf("expected legacy Compaction preserved when end >= KeepFrom, got %+v", forkAt.Compaction)
	}
}

func TestCompactedFileAdvisoryMultibyteUTF8TopicTruncation(t *testing.T) {
	cwd := t.TempDir()
	// Topic with multibyte UTF-8 arrows (" → "), CJK runes, and emojis exceeding 48 runes
	// right across the old 48-byte boundary!
	multibyteTopic := "日本語設定 → キャッシュ最適化 → データベース移行 → セッション履歴検証 → 完了確認テスト 🚀🔥✨"
	st := &core.CompactionState{
		Count:        1,
		NextBlockSeq: 1,
		Blocks: []core.FoldBlock{
			{
				ID:            "b1",
				Tier:          1,
				StartIdx:      0,
				EndIdx:        2,
				Topic:         multibyteTopic,
				Summary:       "## Goal\n- UTF-8 safe advisory.",
				ModifiedFiles: []string{"pkg/utf8.go"},
			},
		},
	}
	st.SyncMirrors()
	msgs := darMsgs(4)
	adv := compactedFileAdvisoryFor(cwd, msgs, st, filepath.Join(cwd, "pkg", "utf8.go"))
	if adv == "" {
		t.Fatal("expected non-empty advisory")
	}
	if strings.ContainsRune(adv, '\uFFFD') {
		t.Fatalf("UTF-8 byte-slice corrupted multibyte runes (found replacement char U+FFFD): %q", adv)
	}
	wantPrefix := strings.TrimSpace(string([]rune(multibyteTopic)[:48])) + "…"
	if !strings.Contains(adv, wantPrefix) {
		t.Fatalf("expected 48-rune truncated topic %q in advisory, got %q", wantPrefix, adv)
	}
}

func TestAutoCompactRefreshesFromActorAndCompactionDeclaresProviderWait(t *testing.T) {
	rec := &SessionRecord{
		ID:       "sess-refresh-wait",
		Messages: darMsgs(8),
		TurnSeq:  4,
		Options:  SessionOptions{Mode: "agentic", Access: "full", Effort: "low"},
	}
	a, st := darActor(t, rec)
	a.state = stateRunning
	a.gen = 1

	var cfgCell configCell
	cfgCell.store(&DaemonConfig{
		HostID:   "h1",
		Settings: HarnessSettings{AutoCompactThreshold: 50},
	})
	a.supCfg = &cfgCell
	go a.run()
	defer func() {
		a.control <- shutdownMsg{}
		<-a.done
	}()

	// Queue mid-turn Effort change + queued sendNow user message on the actor BEFORE autoCompact runs!
	a.inbox <- Envelope{Payload: configureMsg{Options: SessionOptions{Mode: "agentic", Access: "full", Effort: "high"}}}
	a.inbox <- Envelope{Payload: bgNoticeMsg{JobID: "bg-sync-1", Text: "QUEUED_BG_NOTICE_BEFORE_AUTOCOMPACT", Finished: true}}

	var capturedForkReqs []provider.Request
	mockClient := &recordingBridgeClient{
		onStream: func(req provider.Request) {
			capturedForkReqs = append(capturedForkReqs, req)
		},
	}

	ag := core.NewAgent(mockClient, "claude-opus-4-6", "stale-sys", core.NewRegistry())
	ag.SessionID = a.id
	ag.Reasoning = "low"
	var heavy []provider.Message
	for i := 0; i < 8; i++ {
		heavy = append(heavy,
			provider.Message{ID: "u", Role: provider.RoleUser, TurnIndex: i + 1, Content: []provider.Content{provider.TextBlock{Text: strings.Repeat("heavy user context ", 600)}}},
			provider.Message{ID: "a", Role: provider.RoleAssistant, TurnIndex: i + 1, Content: []provider.Content{provider.TextBlock{Text: strings.Repeat("heavy assistant reply ", 600)}}},
		)
	}
	ag.SetMessages(heavy)

	// Intercept actor inbox through a spy relay to record workerWaitMsg declarations while forwarding to actor!
	spyInbox := make(chan Envelope, 64)
	spyDone := make(chan struct{})
	var waitOps []workerWaitMsg
	waitDone := make(chan struct{})
	go func() {
		defer close(waitDone)
		for env := range spyInbox {
			if wm, ok := env.Payload.(workerWaitMsg); ok {
				waitOps = append(waitOps, wm)
			}
			a.inbox <- env
		}
	}()

	w := &turnBridge{
		ctx: context.Background(),
		cfg: *cfgCell.load(),
		snap: workerSnapshot{
			gen:       1,
			epoch:     a.epoch,
			turnIndex: 4,
			model:     "claude-opus-4-6",
			options:   SessionOptions{Mode: "agentic", Access: "full", Effort: "low"},
		},
		env: workerEnv{
			cfg:      &cfgCell,
			store:    st,
			inbox:    spyInbox,
			done:     spyDone,
			actorID:  a.id,
			brainDir: st.ensureBrainDir,
			emit:     func(any) {},
		},
		modelInfo: provider.Model{ID: "claude-opus-4-6", ContextWindow: 12000, MaxOutput: 4096, Reasoning: true},
		client:    mockClient,
		reg:       core.NewRegistry(),
		agent:     ag,
	}

	if err := w.autoCompact(context.Background(), func(ev core.AgentEvent) { w.handleEvent(ev) }); err != nil {
		t.Fatalf("autoCompact: %v", err)
	}
	// Also exercise reactive overflow progress event wait declaration.
	w.handleEvent(core.EvToolProgress{Text: "Context limit reached upstream; automatically compacting older context…"})

	close(spyInbox)
	<-waitDone
	close(spyDone)

	if len(capturedForkReqs) == 0 {
		t.Fatal("expected proactive autoCompact to invoke forked summarizer")
	}
	forkReq := capturedForkReqs[0]
	if forkReq.Reasoning != "high" {
		t.Fatalf("autoCompact ran with stale Effort %q instead of refreshing \"high\" from actor!", forkReq.Reasoning)
	}
	if forkReq.SessionID != a.id {
		t.Fatalf("forkReq.SessionID = %q, want %q", forkReq.SessionID, a.id)
	}
	foundQueuedNotice := false
	for _, m := range forkReq.Messages {
		if m.Meta["background_delivery"] == "bg-sync-1" {
			foundQueuedNotice = true
		}
	}
	if !foundQueuedNotice {
		t.Fatal("autoCompact failed to pull pending actor context before snapshotting warm prefix!")
	}

	providerWaits := 0
	clearedWaits := 0
	for _, wm := range waitOps {
		if wm.op == "provider" && wm.until > 0 {
			providerWaits++
		}
		if wm.op == "" && wm.until == 0 {
			clearedWaits++
		}
	}
	if providerWaits < 2 {
		t.Fatalf("expected provider declareWait on autoCompact + overflow progress, got waitOps=%+v", waitOps)
	}
	if clearedWaits < 1 {
		t.Fatalf("expected autoCompact defer to clear provider wait, got waitOps=%+v", waitOps)
	}
}

type recordingBridgeClient struct {
	onStream func(req provider.Request)
}

func (c *recordingBridgeClient) Name() string { return "anthropic" }

func (c *recordingBridgeClient) Stream(_ context.Context, req provider.Request) (<-chan provider.Event, error) {
	if c.onStream != nil {
		c.onStream(req)
	}
	ch := make(chan provider.Event, 2)
	msg := provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "## Goal\n- Compacted.\n\n## Progress\n- Done."}}}
	ch <- provider.EventDone{Message: msg}
	close(ch)
	return ch, nil
}
