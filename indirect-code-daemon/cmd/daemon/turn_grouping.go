package main

import "indirect/indirect-code-daemon/packages/provider"

// turnGroup is one transcript turn (TurnIndex > 0) with the absolute
// message indices that belong to it, in transcript order.
type turnGroup struct {
	turn int
	idx  []int
}

// turnGroups partitions a transcript into whole turns with ONE shared
// zero-index attachment rule, used by every grouping site (splitRecord,
// sliceTurnMessages, sliceHistoryBlock, sliceLastTurns):
//
//   - A TurnIndex <= 0 message attaches to the FOLLOWING turn (pre-turn
//     system notices ride with the turn they introduce).
//   - Trailing zero-index messages (no following turn) attach to the
//     LAST turn.
//   - An all-zero transcript groups as a single fabricated turn 1
//     (mirrors dropTurnForPrefix: all-zero keeps turn 1).
//
// The result preserves transcript order and is contiguous per group:
// zero-index messages never appear in two groups, so a turn line built
// from a group never duplicates a message across lines.
func turnGroups(msgs []provider.Message) []turnGroup {
	var groups []turnGroup
	pending := []int{}
	flush := func(turn int) {
		if len(pending) == 0 {
			return
		}
		if len(groups) > 0 && groups[len(groups)-1].turn == turn {
			groups[len(groups)-1].idx = append(groups[len(groups)-1].idx, pending...)
		} else {
			groups = append(groups, turnGroup{turn: turn, idx: append([]int{}, pending...)})
		}
		pending = nil
	}
	for i, m := range msgs {
		if m.TurnIndex <= 0 {
			pending = append(pending, i)
			continue
		}
		flush(m.TurnIndex)
		if len(groups) > 0 && groups[len(groups)-1].turn == m.TurnIndex {
			groups[len(groups)-1].idx = append(groups[len(groups)-1].idx, i)
		} else {
			groups = append(groups, turnGroup{turn: m.TurnIndex, idx: []int{i}})
		}
	}
	// Trailing zero-index messages attach to the last turn (or turn 1).
	if len(pending) > 0 {
		if len(groups) > 0 {
			groups[len(groups)-1].idx = append(groups[len(groups)-1].idx, pending...)
		} else {
			groups = append(groups, turnGroup{turn: 1, idx: pending})
		}
	}
	return groups
}
