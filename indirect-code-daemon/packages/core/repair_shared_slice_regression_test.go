package core

// REGRESSION (audit §5, actors scout item 10) — KNOWN FAILING until the
// context-pipeline fix lands.
//
// Bug pinned here: repairToolUseResultPairs (message.go:190-194) appends
// synthesized stub tool_results into msgs[i+1].Content — the Content backing
// array SHARED with the live transcript (a.messages). The pipeline is
// documented as request-only ("the snapshot is taken under mu and every step
// after that works on the copy") but the shallow copy still aliases the
// Content slices. Empirically: the caller's message is mutated (len/cap
// 1/4 -> 2/4) and two concurrent BuildContext runs race on the shared array
// (go test -race).
//
// FIX PASS: delete the t.Skip lines and run
// `go test -race ./packages/core/ -run TestRegressionRepair -v`.
// Suggested fix: clone msgs[i+1].Content before appending stubs (e.g.
// `next := msgs[i+1]; next.Content = append(slices.Clone(next.Content), stubs...)`).

import (
	"sync"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// regressionOrphanTranscript builds [assistant(tool_use t1), tool(result for
// OTHER call)] where the tool message's Content slice has spare capacity —
// the shape that triggers the shared-backing-array append.
func regressionOrphanTranscript() []provider.Message {
	toolContent := make([]provider.Content, 1, 4) // len 1, cap 4: spare room
	toolContent[0] = provider.ToolResultBlock{
		CallID:  "other",
		Content: []provider.Content{provider.TextBlock{Text: "r"}},
	}
	return []provider.Message{
		{Role: provider.RoleAssistant, TurnIndex: 1, Content: []provider.Content{
			provider.ToolCallBlock{ID: "t1", Name: "bash", Arguments: []byte(`{}`)},
		}},
		{Role: provider.RoleTool, TurnIndex: 1, Content: toolContent},
	}
}

// TestRegressionRepairDoesNotMutateInput: the request-only contract — the
// transcript handed to the pipeline must come back byte-identical.
func TestRegressionRepairDoesNotMutateInput(t *testing.T) {
	t.Skip("BUG audit §5-10: repairToolUseResultPairs mutates the shared Content array; unskip when fixing")
	msgs := regressionOrphanTranscript()
	beforeLen := len(msgs[1].Content)
	beforeCap := cap(msgs[1].Content)
	_ = repairToolUseResultPairs(msgs)
	if len(msgs[1].Content) != beforeLen || cap(msgs[1].Content) != beforeCap {
		t.Fatalf("input transcript mutated: tool msg Content len/cap %d/%d -> %d/%d",
			beforeLen, beforeCap, len(msgs[1].Content), cap(msgs[1].Content))
	}
}

// TestRegressionRepairNoRaceOnSharedContent: two concurrent BuildContext
// runs must not race (run with -race) over the transcript's Content arrays.
func TestRegressionRepairNoRaceOnSharedContent(t *testing.T) {
	t.Skip("BUG audit §5-10: concurrent context builds race on shared Content arrays; unskip when fixing")
	a := NewAgent(nil, "", "", nil)
	a.SetMessages(regressionOrphanTranscript())
	var wg sync.WaitGroup
	wg.Add(2)
	for range 2 {
		go func() {
			defer wg.Done()
			for range 200 {
				_ = a.BuildContext()
			}
		}()
	}
	wg.Wait()
}
