package main

import (
	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Turn-granular history pagination: the transcript is append-only and
// every message carries a TurnIndex, so blocks of whole turns are the
// natural page unit (never cut a turn in half). The daemon walks
// backwards from the tail, counting tokens per turn with btdby4, and
// stops as soon as the block reaches the token budget — counting only
// what it sends, never the whole session.
//
// Budget: historyBlockTokens (round-up: the turn crossing the line is
// always included whole, minimum one turn). Safety cap: a single
// monster turn is split by message count (historyBlockMaxMessages)
// instead of blowing the transport budget.

const (
	historyBlockTokens      = 128 * 1024
	historyBlockMaxMessages = 200
)

// historyBlock is one page of transcript: whole turns, newest last.
type historyBlock struct {
	Messages   []provider.Message
	Balloons   []filetrack.TurnChanges
	Attachments []AttachmentRef
	// Mode mirrors the session mode at page time so the ws page path can
	// apply the same assistant-text sanitization as the payload paths.
	Mode string
	OldestTurn int  // smallest TurnIndex in the block (cursor for beforeTurn)
	NewestTurn int  // largest TurnIndex in the block
	HasOlder   bool // more turns exist below OldestTurn
	TotalTurns int  // distinct turn count in the full transcript
	FirstIndex int  // raw transcript offset of Messages[0] (srcIdx base)
}


// sliceHistoryBlock returns the tail block (beforeTurn <= 0) or the block
// of turns strictly below beforeTurn. Turns are grouped with the shared
// turnGroups rule (turn_grouping.go): zero-index notices attach to the
// following turn, trailing notices to the last turn, so a notice between
// turns is never dragged into two blocks and messages of a skipped turn
// (>= beforeTurn) never leak into the page. Balloons whose TurnIndex is
// one of the block's turns ride along.
func sliceHistoryBlock(msgs []provider.Message, balloons []filetrack.TurnChanges, beforeTurn int) historyBlock {
	var out historyBlock
	if len(msgs) == 0 {
		return out
	}
	// Whole-turn groups in transcript order. They partition the
	// transcript, so any run of groups is contiguous and FirstIndex stays
	// the true raw offset of Messages[0] (the srcIdx base).
	all := turnGroups(msgs)
	seen := map[int]bool{}
	for _, g := range all {
		if g.turn != 0 {
			seen[g.turn] = true
		}
	}
	out.TotalTurns = len(seen)
	// Groups eligible for this page: turns strictly below beforeTurn.
	var groups []turnGroup
	for _, g := range all {
		if beforeTurn > 0 && g.turn >= beforeTurn {
			continue
		}
		groups = append(groups, g)
	}
	if len(groups) == 0 {
		return out
	}
	// Walk backwards accumulating whole turns until the budget is met.
	// Blocks are always whole turns (never cut a turn in half): the turn
	// crossing the budget line is included entirely (round-up), minimum
	// one turn. Safety cap: stop adding older turns once the page holds
	// historyBlockMaxMessages messages — a single monster turn still
	// ships whole (it is the freshest data), but it never drags older
	// turns along.
	budget := 0
	held := 0
	first := len(groups) // index into groups of the block's oldest turn
	for i := len(groups) - 1; i >= 0; i-- {
		if i < len(groups)-1 && held >= historyBlockMaxMessages {
			break
		}
		g := groups[i]
		var turnMsgs []provider.Message
		for _, idx := range g.idx {
			turnMsgs = append(turnMsgs, msgs[idx])
		}
		budget += turnTokenCount(turnMsgs)
		held += len(g.idx)
		first = i
		if budget >= historyBlockTokens {
			break
		}
	}
	block := groups[first:]
	out.FirstIndex = block[0].idx[0]
	for _, g := range block {
		for _, idx := range g.idx {
			out.Messages = append(out.Messages, msgs[idx])
		}
	}
	out.OldestTurn = block[0].turn
	out.NewestTurn = block[len(block)-1].turn
	out.HasOlder = first > 0
	turnSet := map[int]bool{}
	for _, g := range block {
		turnSet[g.turn] = true
	}
	for _, b := range balloons {
		if turnSet[b.TurnIndex] {
			out.Balloons = append(out.Balloons, b)
		}
	}
	return out
}

// Completion tail: the last N whole turns (never cut a turn in half),
// minimum one turn, plus the cursor for get_history. The foreground
// client already received every turn message as deltas, so the
// end-of-turn snapshot only needs the fresh turns for reconciliation
// (a lost delta, a second device) — never the full transcript. Bounded
// by turn count, not tokens: the freshest data always ships whole and
// the payload stops growing with session age.
const completionTailTurns = 2

// sliceLastTurns returns the block of the last n whole turns in
// transcript order, newest last, grouped with the shared turnGroups
// rule: TurnIndex 0 prefix messages (pre-turn system notices) ride with
// the first block turn, mirroring sliceHistoryBlock.
func sliceLastTurns(msgs []provider.Message, balloons []filetrack.TurnChanges, n int) historyBlock {
	var out historyBlock
	if len(msgs) == 0 || n <= 0 {
		return out
	}
	all := turnGroups(msgs)
	seen := map[int]bool{}
	for _, g := range all {
		if g.turn != 0 {
			seen[g.turn] = true
		}
	}
	out.TotalTurns = len(seen)
	if len(all) == 0 {
		return out
	}
	first := len(all) - n
	if first < 0 {
		first = 0
	}
	block := all[first:]
	out.FirstIndex = block[0].idx[0]
	for _, g := range block {
		for _, idx := range g.idx {
			out.Messages = append(out.Messages, msgs[idx])
		}
	}
	out.OldestTurn = block[0].turn
	out.NewestTurn = block[len(block)-1].turn
	out.HasOlder = first > 0
	turnSet := map[int]bool{}
	for _, g := range block {
		turnSet[g.turn] = true
	}
	for _, b := range balloons {
		if turnSet[b.TurnIndex] {
			out.Balloons = append(out.Balloons, b)
		}
	}
	return out
}

// historyCursorMap is the get_history cursor shape shared by every
// transcript-carrying event (session_data/session_content/
// session_compacted): the client merges by id, seals the block, and
// pages backwards from oldestTurn when the user scrolls up.
func historyCursorMap(block historyBlock) map[string]any {
	return map[string]any{
		"oldestTurn": block.OldestTurn,
		"newestTurn": block.NewestTurn,
		"hasOlder":   block.HasOlder,
		"totalTurns": block.TotalTurns,
		"firstIndex": block.FirstIndex,
	}
}

// completionPayload is the end-of-turn session_data shape: the full
// closing metadata (usage, compaction, context, todos, model/options,
// queue, attachments, file balloons of the tail) plus ONLY the last
// completionTailTurns whole turns + cursor. The foreground client
// reconciles the fresh turns by id; older turns are untouched.
// Call with the record lock held.
func completionPayload(rec *SessionRecord) map[string]any {
	p := sessionPayload(rec)
	block := sliceLastTurns(rec.Messages, rec.FileBalloons, completionTailTurns)
	p["messages"] = sanitizeMessagesForFrontend(rec.Options.Mode, block.Messages, rec.Attachments)
	p["fileBalloons"] = fileBalloonPayloads(block.Balloons)
	p["history"] = historyCursorMap(block)
	return p
}

// tailContentEvent is the session_content/session_compacted shape for
// out-of-turn sync points (edit, slash reply, truncate tail, quiet
// context notice, compaction): the affected tail turns + the same
// history cursor, so the client merges instead of replacing the list.
// n<=0 means the completion default (completionTailTurns).
func tailContentEvent(hostID, sessionID string, typ string, rec *SessionRecord, n int, extra map[string]any) map[string]any {
	if n <= 0 {
		n = completionTailTurns
	}
	block := sliceLastTurns(rec.Messages, rec.FileBalloons, n)
	ev := map[string]any{
		"type":       typ,
		"hostId":     hostID,
		"sessionId":  sessionID,
		"messages":   sanitizeMessagesForFrontend(rec.Options.Mode, block.Messages, rec.Attachments),
		"compaction": rec.Compaction,
		"history":    historyCursorMap(block),
	}
	for k, v := range extra {
		ev[k] = v
	}
	return ev
}
