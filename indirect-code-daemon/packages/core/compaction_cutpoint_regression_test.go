package core

import (
	"fmt"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Regression (audit bug 6): keepRecent <= 0 left idx at len(msgs) and the
// tool-pair loop indexed msgs[len(msgs)] — panic on the exported API.
func TestFindCutPointMsgsKeepRecentNonPositiveDoesNotPanic(t *testing.T) {
	asst, tool := toolTurn("read", `{"path":"a"}`, "out")
	msgs := []provider.Message{asst, tool}
	_, perMsg := provider.ContextTokensByMessage("", nil, msgs)
	for _, keep := range []int{0, -1} {
		cut := FindCutPointMsgs(msgs, keep, perMsg)
		if cut.Index < 0 || cut.Index >= len(msgs) {
			t.Fatalf("keep=%d: cut out of range: %+v (len=%d)", keep, cut, len(msgs))
		}
	}
}

// Regression (audit bug 50): with no user boundary anywhere in the
// transcript the cut snapped to Index 0, and Compact treated 0 as "nothing
// worth summarizing" — a no-op on an oversized transcript. The cut must fall
// back past the keep-floor walk-back (the oldest tool group start) so a
// summary happens.
func TestFindCutPointMsgsBoundarylessToolResultsFallBackToGroupStart(t *testing.T) {
	var msgs []provider.Message
	for i := range 10 {
		msgs = append(msgs, provider.Message{
			Role: provider.RoleTool,
			Content: []provider.Content{provider.ToolResultBlock{
				CallID:  fmt.Sprintf("c%d", i),
				Content: []provider.Content{provider.TextBlock{Text: strings.Repeat("z", 20000)}},
			}},
		})
	}
	_, perMsg := provider.ContextTokensByMessage("", nil, msgs)
	cut := FindCutPointMsgs(msgs, 10000, perMsg)
	if cut.Index <= 0 || cut.Index >= len(msgs) {
		t.Fatalf("boundary-less oversized transcript must cut > 0 so Compact summarizes: %+v (len=%d)", cut, len(msgs))
	}
}
