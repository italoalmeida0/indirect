package core

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"indirect/indirect-code-daemon/packages/provider"
)

func mustJSONContext(t *testing.T, msgs []provider.Message) string {
	t.Helper()
	b, err := json.Marshal(msgs)
	if err != nil {
		t.Fatalf("json.Marshal(msgs): %v", err)
	}
	return string(b)
}

func TestViewLatchPreservesBytesAcrossQuietTurnsAndToolSteps(t *testing.T) {
	a := NewAgent(nil, "claude-sonnet-4-6", "system prompt", nil)

	// Turn 1 includes a large (>ToolOutputMaxChars) tool output.
	heavyOut := strings.Repeat("line-from-turn-1-output\n", 600) // ~14.4KB > 8000 chars
	call1, res1 := toolTurn("bash", `{"command":"go test ./..."}`, heavyOut)
	a.SetMessages([]provider.Message{
		textMsg(provider.RoleUser, "turn 1 user prompt"),
		call1,
		res1,
		textMsg(provider.RoleAssistant, "turn 1 done"),
	})

	ctxTurn1 := a.BuildContext()
	prefixTurn1 := mustJSONContext(t, ctxTurn1)

	// Append Turn 2 and Turn 3 (crossing the old sliding T-2 user-turn boundary).
	a.AppendUserContext("turn 2 user prompt", nil)
	a.messages = append(a.messages, textMsg(provider.RoleAssistant, "turn 2 reply"))
	a.AppendUserContext("turn 3 user prompt", nil)

	ctxTurn3 := a.BuildContext()
	if got := mustJSONContext(t, ctxTurn3[:len(ctxTurn1)]); got != prefixTurn1 {
		t.Fatalf("ViewLatch violation across quiet turns: Turn 1 prefix mutated at T-3!\nwant: %s\ngot:  %s", prefixTurn1[:200], got[:200])
	}

	// Simulate a multi-step tool loop within Turn 3 exceeding PruneProtectTokens (>40K tokens).
	for step := 0; step < 8; step++ {
		bigStepOut := fmt.Sprintf("step-%d:", step) + strings.Repeat("Z", 22000)
		c, r := toolTurn("read", fmt.Sprintf(`{"path":"file_%d.go"}`, step), bigStepOut)
		// Give unique IDs so repairToolUseResultPairs treats each pair distinctly.
		id := fmt.Sprintf("call-loop-%d", step)
		c.Content = []provider.Content{provider.ToolCallBlock{ID: id, Name: "read", Arguments: mustRaw(fmt.Sprintf(`{"path":"file_%d.go"}`, step))}}
		r.Content = []provider.Content{provider.ToolResultBlock{CallID: id, Content: []provider.Content{provider.TextBlock{Text: bigStepOut}}}}
		a.messages = append(a.messages, c, r)

		ctxStep := a.BuildContext()
		if got := mustJSONContext(t, ctxStep[:len(ctxTurn1)]); got != prefixTurn1 {
			t.Fatalf("ViewLatch violation at tool step %d (>40K loop): Turn 1 prefix bytes mutated!", step)
		}
	}
}

func TestViewLatchMonotonicWatermarkAdvancesOnlyAtCompaction(t *testing.T) {
	client := &scriptableFakeClient{summaries: []string{"folded era one"}}
	a := NewAgent(client, "m", "", nil)

	heavy := strings.Repeat("H", ToolOutputMaxChars+4000)
	var history []provider.Message
	// 6 turns total; we compact keeping last 9 messages (3 turns in kept tail).
	for turn := 1; turn <= 6; turn++ {
		history = append(history, textMsg(provider.RoleUser, fmt.Sprintf("user turn %d", turn)))
		id := fmt.Sprintf("tc-%d", turn)
		call := provider.Message{
			Role:    provider.RoleAssistant,
			Content: []provider.Content{provider.ToolCallBlock{ID: id, Name: "bash", Arguments: mustRaw(`{"command":"ls"}`)}},
		}
		res := provider.Message{
			Role: provider.RoleTool,
			Content: []provider.Content{provider.ToolResultBlock{
				CallID:  id,
				Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("turn-%d-%s", turn, heavy)}},
			}},
		}
		history = append(history, call, res)
	}
	a.SetMessages(history) // 18 messages

	if _, err := a.Compact(context.Background(), 9, nil); err != nil {
		t.Fatalf("Compact failed: %v", err)
	}
	chain := a.CompactionChain()
	if chain == nil {
		t.Fatal("expected non-nil CompactionChain")
	}
	// KeepFrom = 9 (start of turn 4). Kept tail has turns 4, 5, 6.
	// ComputeLatchWatermark protects turns 5 and 6 (last 2 user turns -> index 12),
	// latching turn 4's oversized tool output at index 11!
	if chain.KeepFrom != 9 {
		t.Fatalf("KeepFrom = %d, want 9", chain.KeepFrom)
	}
	if chain.PrunedBefore != 12 {
		t.Fatalf("PrunedBefore = %d, want 12", chain.PrunedBefore)
	}

	ctxAfterCompact := a.BuildContext()
	// ctxAfterCompact[0] = synthetic FoldBlock b1
	// ctxAfterCompact[1..3] = turn 4 (user, call, latched tool)
	// ctxAfterCompact[4..6] = turn 5 (unlatched)
	// ctxAfterCompact[7..9] = turn 6 (unlatched)
	trTurn4 := ctxAfterCompact[3].Content[0].(provider.ToolResultBlock).Content[0].(provider.TextBlock)
	if trTurn4.Text != PrunedToolNotice {
		t.Fatalf("expected turn 4 tool output below PrunedBefore to be latched, got len=%d", len(trTurn4.Text))
	}
	trTurn5 := ctxAfterCompact[6].Content[0].(provider.ToolResultBlock).Content[0].(provider.TextBlock)
	if !strings.HasPrefix(trTurn5.Text, "turn-5-") {
		t.Fatalf("expected turn 5 tool output at/above PrunedBefore to remain intact")
	}

	// Raw history must never be mutated by ViewLatch.
	rawTurn4 := a.History()[11].Content[0].(provider.ToolResultBlock).Content[0].(provider.TextBlock)
	if !strings.HasPrefix(rawTurn4.Text, "turn-4-") {
		t.Fatalf("raw history was mutated by ViewLatch!")
	}

	// Appending Turn 7 without compacting must NOT advance PrunedBefore or latch Turn 5!
	snapBeforeTurn7 := mustJSONContext(t, ctxAfterCompact)
	a.AppendUserContext("user turn 7", nil)
	ctxAfterTurn7 := a.BuildContext()
	if got := mustJSONContext(t, ctxAfterTurn7[:len(ctxAfterCompact)]); got != snapBeforeTurn7 {
		t.Fatalf("projected prefix mutated on quiet Turn 7 append!")
	}
}

func TestContextSnapshotMeasuresPostLatchPostFilterPostSkillPrefix(t *testing.T) {
	a := NewAgent(nil, "m", "sys", nil)

	heavy := strings.Repeat("X", 24000)
	call := provider.Message{
		Role:    provider.RoleAssistant,
		Content: []provider.Content{provider.ToolCallBlock{ID: "c1", Name: "bash", Arguments: mustRaw(`{"command":"cat big"}`)}},
	}
	res := provider.Message{
		Role:    provider.RoleTool,
		Content: []provider.Content{provider.ToolResultBlock{CallID: "c1", Content: []provider.Content{provider.TextBlock{Text: heavy}}}},
	}
	hidden := textMsg(provider.RoleUser, strings.Repeat("hidden-internal-payload ", 1000))
	hidden.Meta = map[string]string{MetaHidden: "true"}

	a.SetMessages([]provider.Message{
		textMsg(provider.RoleUser, "turn 1"),
		call,
		res,
		hidden,
		textMsg(provider.RoleUser, "turn 2"),
	})
	a.SeedCompactionState(&CompactionState{
		PrunedBefore: 3, // latches res at index 2
	})
	skillBanner := "<system-reminder><skill name=\"build\">" + strings.Repeat("skill-rule ", 200) + "</skill></system-reminder>\n"
	a.RequestMessages = func(msgs []provider.Message) []provider.Message {
		out := append([]provider.Message(nil), msgs...)
		last := len(out) - 1
		if last >= 0 {
			cp := out[last]
			cp.Content = []provider.Content{provider.TextBlock{Text: skillBanner + extractText(cp)}}
			out[last] = cp
		}
		return out
	}

	sys, tools, snapMsgs := a.ContextSnapshot()
	counted := provider.ContextTokens(sys, tools, snapMsgs)

	// Unfiltered + unlatched raw messages would exceed 14,000 tokens;
	// post-filter + post-latch + skillBanner is ~800 tokens.
	rawToks := provider.ContextTokens(sys, tools, a.History())
	if counted >= rawToks/2 {
		t.Fatalf("ContextSnapshot counted phantom unpruned/hidden tokens: got %d vs raw %d", counted, rawToks)
	}
	if !strings.Contains(extractText(snapMsgs[len(snapMsgs)-1]), `<skill name="build">`) {
		t.Fatalf("ContextSnapshot missed RequestMessages skill prefix injection")
	}
	for _, m := range snapMsgs {
		if m.Meta != nil && m.Meta[MetaHidden] == "true" {
			t.Fatalf("ContextSnapshot leaked hidden message into snapshot")
		}
	}
}
