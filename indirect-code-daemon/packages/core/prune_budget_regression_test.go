package core

import (
	"strings"
	"testing"

	"indirect/indirect-code-daemon/packages/provider"
)

// Regression (audit bug 15): PruneOldToolResults counted the WHOLE tool
// message once per ToolResultBlock, so k blocks burned k x the protection
// budget and blocks inside the budget were truncated anyway. One tool
// message with 3 blocks of ~10k tokens (30k total < 40k budget) must stay
// intact.
func TestPruneOldToolResultsCountsBudgetPerBlock(t *testing.T) {
	toolMsg := provider.Message{
		Role: provider.RoleTool,
		Content: []provider.Content{
			provider.ToolResultBlock{CallID: "c1", Content: []provider.Content{provider.TextBlock{Text: strings.Repeat("A", 40000)}}},
			provider.ToolResultBlock{CallID: "c2", Content: []provider.Content{provider.TextBlock{Text: strings.Repeat("B", 40000)}}},
			provider.ToolResultBlock{CallID: "c3", Content: []provider.Content{provider.TextBlock{Text: strings.Repeat("C", 40000)}}},
		},
	}
	msgs := []provider.Message{textMsg(provider.RoleUser, "run the tools"), toolMsg}

	got := PruneOldToolResults(msgs)

	if len(got[1].Content) != 3 {
		t.Fatalf("block count changed: %d", len(got[1].Content))
	}
	for i, c := range got[1].Content {
		trb, ok := c.(provider.ToolResultBlock)
		if !ok {
			t.Fatalf("block %d: unexpected %T", i, c)
		}
		tb, ok := trb.Content[0].(provider.TextBlock)
		if !ok {
			t.Fatalf("block %d: unexpected inner %T", i, trb.Content[0])
		}
		if strings.Contains(tb.Text, "[truncated]") || strings.Contains(tb.Text, PrunedToolNotice) {
			t.Fatalf("block %d pruned/truncated inside the protection budget (3 x ~10k tokens < %d): %.40q...",
				i, PruneProtectTokens, tb.Text)
		}
	}
}
