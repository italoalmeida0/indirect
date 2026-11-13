package core

import (
	"indirect/indirect-code-daemon/packages/provider"
)

// ApplyViewLatchTail applies monotonic watermark tool-output pruning over a
// raw history tail slice starting at rawStart (`history[rawStart:]`).
//
// Unlike sliding per-turn PruneOldToolResults (which recomputed a moving
// T-2 user-turn / 40K-token boundary on every turn and tool step, mutating
// middle message bytes and invalidating upstream KV caches), ViewLatch only
// clears heavy tool outputs strictly below state.PrunedBefore. Because
// PrunedBefore advances monotonically ONLY at compaction/overflow boundaries,
// every byte of the projected context remains 100% immutable across quiet
// turns and across all 1..N tool steps within a turn.
//
// The input slice and underlying message content slices are never mutated.
func ApplyViewLatchTail(tail []provider.Message, rawStart int, prunedBefore int) []provider.Message {
	if len(tail) == 0 || prunedBefore <= rawStart {
		return tail
	}

	limit := prunedBefore - rawStart
	if limit > len(tail) {
		limit = len(tail)
	}

	var out []provider.Message
	for i := 0; i < limit; i++ {
		m := tail[i]
		if m.Role != provider.RoleTool {
			continue
		}
		prunedMsg, changed := latchPruneToolMessage(m)
		if !changed {
			continue
		}
		if out == nil {
			out = make([]provider.Message, len(tail))
			copy(out, tail)
		}
		out[i] = prunedMsg
	}
	if out == nil {
		return tail
	}
	return out
}

func latchPruneToolMessage(m provider.Message) (provider.Message, bool) {
	modified := false
	newContent := make([]provider.Content, len(m.Content))
	for idx, c := range m.Content {
		trb, ok := c.(provider.ToolResultBlock)
		if !ok {
			newContent[idx] = c
			continue
		}
		blockMod := false
		innerOut := make([]provider.Content, len(trb.Content))
		for j, inner := range trb.Content {
			tb, isText := inner.(provider.TextBlock)
			if isText && len(tb.Text) > ToolOutputMaxChars {
				innerOut[j] = provider.TextBlock{
					Text:             PrunedToolNotice,
					ThoughtSignature: tb.ThoughtSignature,
				}
				blockMod = true
			} else {
				innerOut[j] = inner
			}
		}
		if blockMod {
			trb.Content = innerOut
			modified = true
		}
		newContent[idx] = trb
	}
	if !modified {
		return m, false
	}
	cp := m
	cp.Content = newContent
	return cp, true
}

// ComputeLatchWatermarkAt computes the global raw-history watermark when
// history[0] corresponds to global transcript index baseMsgIdx.
func ComputeLatchWatermarkAt(history []provider.Message, baseMsgIdx int, globalKeepFrom int, protectTokens int) int {
	if baseMsgIdx < 0 {
		baseMsgIdx = 0
	}
	localKeep := globalKeepFrom - baseMsgIdx
	if localKeep < 0 {
		localKeep = 0
	}
	return baseMsgIdx + ComputeLatchWatermark(history, localKeep, protectTokens)
}

// ComputeLatchWatermark computes the monotonic raw-history index below which
// oversized tool outputs in the kept tail [keepFrom, len(history)) may be
// latched at a compaction or overflow boundary.
//
// It protects the last 2 visible user turns AND up to protectTokens of the
// most recent tool results. Calling this ONLY at compaction/overflow time
// guarantees zero mid-turn or quiet-turn prefix mutations.
func ComputeLatchWatermark(history []provider.Message, keepFrom int, protectTokens int) int {
	if keepFrom < 0 {
		keepFrom = 0
	}
	if keepFrom >= len(history) {
		return keepFrom
	}
	if protectTokens <= 0 {
		protectTokens = PruneProtectTokens
	}

	userTurns := 0
	recentUserBoundary := keepFrom
	hasTwoUserTurns := false
	for i := len(history) - 1; i >= keepFrom; i-- {
		if isUserBoundary(history[i]) {
			userTurns++
			if userTurns >= 2 {
				recentUserBoundary = i
				hasTwoUserTurns = true
				break
			}
		}
	}

	recentToolTokens := 0
	budgetBoundary := keepFrom
	exceededBudget := false
	for i := len(history) - 1; i >= keepFrom; i-- {
		m := history[i]
		if m.Role != provider.RoleTool {
			continue
		}
		msgToolToks := 0
		for _, c := range m.Content {
			trb, ok := c.(provider.ToolResultBlock)
			if !ok {
				continue
			}
			msgToolToks += provider.ContextTokens("", nil, []provider.Message{{
				Role:    provider.RoleTool,
				Content: []provider.Content{trb},
			}})
		}
		if recentToolTokens+msgToolToks > protectTokens {
			budgetBoundary = i + 1
			exceededBudget = true
			break
		}
		recentToolTokens += msgToolToks
	}

	wm := keepFrom
	if hasTwoUserTurns && recentUserBoundary > wm {
		wm = recentUserBoundary
	}
	if exceededBudget && budgetBoundary > wm {
		wm = budgetBoundary
	}
	if wm > len(history) {
		wm = len(history)
	}
	return wm
}
