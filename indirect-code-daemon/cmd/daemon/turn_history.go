package main

import (
	"indirect/indirect-code-daemon/packages/filetrack"
	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/sessionstore"
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
	Messages    []provider.Message
	Balloons    []filetrack.TurnChanges
	Attachments []AttachmentRef
	// Mode mirrors the session mode at page time so the ws page path can
	// apply the same assistant-text sanitization as the payload paths.
	Mode         string
	Direction    string // "older" | "newer" | "around" | ""
	OldestTurn   int    // smallest TurnIndex in the block (cursor for beforeTurn)
	NewestTurn   int    // largest TurnIndex in the block (cursor for afterTurn)
	HasOlder     bool   // more turns exist below OldestTurn
	HasNewer     bool   // more turns exist above NewestTurn
	TotalTurns   int    // distinct turn count in the full transcript
	FirstIndex   int    // raw global transcript offset of Messages[0] (srcIdx base)
	TargetMsgIdx *int   // resolved target raw message index for around jumps
}

type historyQuery struct {
	BeforeTurn   int
	AfterTurn    int
	AroundTurn   int
	AroundMsgIdx *int
}

func adjustBlockForHotBase(block *historyBlock, rec *SessionRecord) {
	if rec == nil {
		return
	}
	if rec.HotBaseMsgIdx > 0 {
		block.FirstIndex += rec.HotBaseMsgIdx
		block.HasOlder = true
	}
	if rec.TotalTurns > block.TotalTurns {
		block.TotalTurns = rec.TotalTurns
	} else if rec.HotBaseTurn > 1 {
		// Fallback when TotalTurns wasn't pre-populated: HotBaseTurn-1 prefix turns exist.
		distinctHot := block.TotalTurns
		if prefixApprox := (rec.HotBaseTurn - 1) + distinctHot; prefixApprox > block.TotalTurns {
			block.TotalTurns = prefixApprox
		}
	}
}

func fromStoreWindowResult(win sessionstore.WindowSlice, direction string) historyBlock {
	return historyBlock{
		Messages:     win.Messages,
		Balloons:     win.FileBalloons,
		Direction:    direction,
		OldestTurn:   win.History.OldestTurn,
		NewestTurn:   win.History.NewestTurn,
		HasOlder:     win.History.HasOlder,
		HasNewer:     win.History.HasNewer,
		TotalTurns:   win.History.TotalTurns,
		FirstIndex:   win.History.FirstIndex,
		TargetMsgIdx: win.History.TargetMsgIdx,
	}
}

// sliceHistoryBlockForRecord slices from rec's hot resident window and
// adjusts FirstIndex / HasOlder / TotalTurns to global session coordinates.
func sliceHistoryBlockForRecord(rec *SessionRecord, beforeTurn int) historyBlock {
	if rec == nil {
		return historyBlock{}
	}
	block := sliceHistoryBlock(rec.Messages, rec.FileBalloons, beforeTurn)
	adjustBlockForHotBase(&block, rec)
	return block
}

// sliceLastTurnsForRecord slices the last n whole turns from rec's hot
// resident window and adjusts FirstIndex / HasOlder / TotalTurns to global
// session coordinates.
func sliceLastTurnsForRecord(rec *SessionRecord, n int) historyBlock {
	if rec == nil {
		return historyBlock{}
	}
	block := sliceLastTurns(rec.Messages, rec.FileBalloons, n)
	adjustBlockForHotBase(&block, rec)
	return block
}

// sliceAfterTurn returns whole turns strictly above afterTurn up to the
// token/message budget (in-memory helper for non-v2 or hot-resident slices).
func sliceAfterTurn(msgs []provider.Message, balloons []filetrack.TurnChanges, afterTurn int) historyBlock {
	var out historyBlock
	out.Direction = "newer"
	if len(msgs) == 0 {
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
	start := len(all)
	for i, g := range all {
		if g.turn > afterTurn {
			start = i
			break
		}
	}
	if start >= len(all) {
		out.HasOlder = len(all) > 0
		return out
	}
	budget := 0
	held := 0
	last := start
	for i := start; i < len(all); i++ {
		if i > start && held >= historyBlockMaxMessages {
			break
		}
		g := all[i]
		var turnMsgs []provider.Message
		for _, idx := range g.idx {
			turnMsgs = append(turnMsgs, msgs[idx])
		}
		budget += turnTokenCount(turnMsgs)
		held += len(g.idx)
		last = i
		if budget >= historyBlockTokens {
			break
		}
	}
	block := all[start : last+1]
	out.FirstIndex = block[0].idx[0]
	turnSet := map[int]bool{}
	for _, g := range block {
		turnSet[g.turn] = true
		for _, idx := range g.idx {
			out.Messages = append(out.Messages, msgs[idx])
		}
	}
	out.OldestTurn = block[0].turn
	out.NewestTurn = block[len(block)-1].turn
	out.HasOlder = start > 0
	out.HasNewer = last+1 < len(all)
	for _, b := range balloons {
		if turnSet[b.TurnIndex] {
			out.Balloons = append(out.Balloons, b)
		}
	}
	return out
}

// sliceAroundGroup centers a page around targetGroupIdx in all.
func sliceAroundGroup(msgs []provider.Message, balloons []filetrack.TurnChanges, all []turnGroup, targetGroupIdx int, targetMsg *int) historyBlock {
	var out historyBlock
	out.Direction = "around"
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
	if targetGroupIdx < 0 {
		targetGroupIdx = 0
	}
	if targetGroupIdx >= len(all) {
		targetGroupIdx = len(all) - 1
	}
	groupTokens := func(g turnGroup) int {
		var tm []provider.Message
		for _, idx := range g.idx {
			tm = append(tm, msgs[idx])
		}
		return max(1, turnTokenCount(tm))
	}
	lo, hi := targetGroupIdx, targetGroupIdx
	budget := groupTokens(all[targetGroupIdx])
	held := len(all[targetGroupIdx].idx)
	for budget < historyBlockTokens && held < historyBlockMaxMessages && (lo > 0 || hi+1 < len(all)) {
		progressed := false
		if lo > 0 && budget < historyBlockTokens && held < historyBlockMaxMessages {
			lo--
			budget += groupTokens(all[lo])
			held += len(all[lo].idx)
			progressed = true
		}
		if hi+1 < len(all) && budget < historyBlockTokens && held < historyBlockMaxMessages {
			hi++
			budget += groupTokens(all[hi])
			held += len(all[hi].idx)
			progressed = true
		}
		if !progressed {
			break
		}
	}
	block := all[lo : hi+1]
	out.FirstIndex = block[0].idx[0]
	turnSet := map[int]bool{}
	for _, g := range block {
		turnSet[g.turn] = true
		for _, idx := range g.idx {
			out.Messages = append(out.Messages, msgs[idx])
		}
	}
	out.OldestTurn = block[0].turn
	out.NewestTurn = block[len(block)-1].turn
	out.HasOlder = lo > 0
	out.HasNewer = hi+1 < len(all)
	if targetMsg != nil {
		cp := *targetMsg
		out.TargetMsgIdx = &cp
	} else {
		cp := out.FirstIndex
		out.TargetMsgIdx = &cp
	}
	for _, b := range balloons {
		if turnSet[b.TurnIndex] {
			out.Balloons = append(out.Balloons, b)
		}
	}
	return out
}

func sliceAroundTurn(msgs []provider.Message, balloons []filetrack.TurnChanges, aroundTurn int) historyBlock {
	all := turnGroups(msgs)
	if len(all) == 0 {
		return historyBlock{Direction: "around"}
	}
	idx := len(all) - 1
	for i, g := range all {
		if g.turn >= aroundTurn {
			idx = i
			break
		}
	}
	targetMsg := all[idx].idx[0]
	return sliceAroundGroup(msgs, balloons, all, idx, &targetMsg)
}

func sliceAroundMsg(msgs []provider.Message, balloons []filetrack.TurnChanges, targetMsgIdx int) historyBlock {
	all := turnGroups(msgs)
	if len(all) == 0 {
		return historyBlock{Direction: "around"}
	}
	if targetMsgIdx < 0 {
		targetMsgIdx = 0
	}
	if targetMsgIdx >= len(msgs) {
		targetMsgIdx = len(msgs) - 1
	}
	idx := len(all) - 1
	for i, g := range all {
		if len(g.idx) > 0 && g.idx[len(g.idx)-1] >= targetMsgIdx {
			idx = i
			break
		}
	}
	return sliceAroundGroup(msgs, balloons, all, idx, &targetMsgIdx)
}

// queryActorHistoryBlock resolves any tail, beforeTurn, afterTurn, aroundTurn,
// or aroundMsgIdx window from the resident Hot Window when covered in RAM, or
// from sessionstore v2 segments overlaid with any uncommitted live WAL messages.
func (a *sessionActor) queryHistoryBlock(q historyQuery) historyBlock {
	rec := a.rec
	if rec == nil {
		return historyBlock{}
	}
	hasV2 := a.store != nil && a.store.v2.HasV2Session(a.id)
	isTail := q.BeforeTurn <= 0 && q.AfterTurn <= 0 && q.AroundTurn <= 0 && q.AroundMsgIdx == nil

	// Fast path 1: Tail request — a.rec ALWAYS holds the Hot Resident Window
	// (>= tailDisplayFirstTurn), so tail snapshots serve straight from RAM!
	if isTail {
		block := sliceHistoryBlockForRecord(rec, 0)
		block.Messages = cloneMessages(block.Messages)
		block.Attachments = append([]AttachmentRef(nil), rec.Attachments...)
		block.Mode = rec.Options.Mode
		return block
	}

	// Fast path 2: Entire session is in RAM (HotBaseMsgIdx == 0) — serve any
	// direction in-memory without touching disk!
	if rec.HotBaseMsgIdx == 0 && (!hasV2 || len(rec.Messages) >= rec.TotalMsgs) {
		var block historyBlock
		switch {
		case q.AroundMsgIdx != nil:
			block = sliceAroundMsg(rec.Messages, rec.FileBalloons, *q.AroundMsgIdx)
		case q.AroundTurn > 0:
			block = sliceAroundTurn(rec.Messages, rec.FileBalloons, q.AroundTurn)
		case q.AfterTurn > 0:
			block = sliceAfterTurn(rec.Messages, rec.FileBalloons, q.AfterTurn)
		default:
			block = sliceHistoryBlock(rec.Messages, rec.FileBalloons, q.BeforeTurn)
			block.Direction = "older"
		}
		block.Messages = cloneMessages(block.Messages)
		block.Attachments = append([]AttachmentRef(nil), rec.Attachments...)
		block.Mode = rec.Options.Mode
		return block
	}

	if !hasV2 {
		// Legacy fallback when HotBaseMsgIdx > 0 shouldn't happen without v2,
		// but guard defensively.
		block := sliceHistoryBlockForRecord(rec, q.BeforeTurn)
		block.Direction = "older"
		block.Messages = cloneMessages(block.Messages)
		block.Attachments = append([]AttachmentRef(nil), rec.Attachments...)
		block.Mode = rec.Options.Mode
		return block
	}

	// Determine uncommitted live tail messages (e.g. open WAL turn not yet in v2).
	entries, _ := a.store.v2.ReadTurnIndex(a.id)
	diskMsgs := 0
	diskLastTurn := 0
	diskTurns := len(entries)
	if diskTurns > 0 {
		last := entries[diskTurns-1]
		diskMsgs = last.LastMsgIdx + 1
		diskLastTurn = last.TurnSeq
	}
	totalMsgs := rec.globalMsgCount()
	var liveTailMsgs []provider.Message
	var liveTailBalloons []filetrack.TurnChanges
	liveExtraTurns := 0
	if totalMsgs > diskMsgs {
		localStart := max(0, diskMsgs-rec.HotBaseMsgIdx)
		if localStart < len(rec.Messages) {
			liveTailMsgs = rec.Messages[localStart:]
			seenLive := map[int]bool{}
			for _, m := range liveTailMsgs {
				if m.TurnIndex > diskLastTurn {
					seenLive[m.TurnIndex] = true
				}
			}
			liveExtraTurns = len(seenLive)
			for _, b := range rec.FileBalloons {
				if b.TurnIndex > diskLastTurn {
					liveTailBalloons = append(liveTailBalloons, b)
				}
			}
		}
	}

	var block historyBlock
	switch {
	case q.AroundMsgIdx != nil:
		target := *q.AroundMsgIdx
		if target >= diskMsgs && len(liveTailMsgs) > 0 {
			// Target is in the Hot Window / live tail!
			localIdx := max(0, target-rec.HotBaseMsgIdx)
			block = sliceAroundMsg(rec.Messages, rec.FileBalloons, localIdx)
			adjustBlockForHotBase(&block, rec)
			cp := min(max(0, target), max(0, totalMsgs-1))
			block.TargetMsgIdx = &cp
		} else {
			win, err := a.store.v2.ReadAroundMsg(a.id, target, historyBlockTokens, historyBlockMaxMessages)
			if err == nil {
				block = fromStoreWindowResult(win, "around")
				if liveExtraTurns > 0 {
					block.TotalTurns += liveExtraTurns
					block.HasNewer = true
				}
			}
		}
	case q.AroundTurn > 0:
		if q.AroundTurn > diskLastTurn && len(liveTailMsgs) > 0 {
			block = sliceAroundTurn(rec.Messages, rec.FileBalloons, q.AroundTurn)
			adjustBlockForHotBase(&block, rec)
			if block.TargetMsgIdx != nil {
				adj := *block.TargetMsgIdx + rec.HotBaseMsgIdx
				block.TargetMsgIdx = &adj
			}
		} else {
			win, err := a.store.v2.ReadAroundTurn(a.id, q.AroundTurn, historyBlockTokens, historyBlockMaxMessages)
			if err == nil {
				block = fromStoreWindowResult(win, "around")
				if liveExtraTurns > 0 {
					block.TotalTurns += liveExtraTurns
					block.HasNewer = true
				}
			}
		}
	case q.AfterTurn > 0:
		if q.AfterTurn >= diskLastTurn && len(liveTailMsgs) > 0 {
			block = sliceAfterTurn(liveTailMsgs, liveTailBalloons, q.AfterTurn)
			block.FirstIndex += diskMsgs
			block.HasOlder = diskTurns > 0 || block.HasOlder
			block.TotalTurns = diskTurns + liveExtraTurns
		} else {
			win, err := a.store.v2.ReadAfterTurn(a.id, q.AfterTurn, historyBlockTokens, historyBlockMaxMessages)
			if err == nil {
				block = fromStoreWindowResult(win, "newer")
				if liveExtraTurns > 0 {
					block.TotalTurns += liveExtraTurns
					if !block.HasNewer && len(block.Messages)+len(liveTailMsgs) <= historyBlockMaxMessages {
						block.Messages = append(block.Messages, cloneMessages(liveTailMsgs)...)
						block.Balloons = append(block.Balloons, liveTailBalloons...)
						if len(liveTailMsgs) > 0 {
							if t := liveTailMsgs[len(liveTailMsgs)-1].TurnIndex; t > block.NewestTurn {
								block.NewestTurn = t
							}
						}
					} else {
						block.HasNewer = true
					}
				}
			}
		}
	default:
		// BeforeTurn > 0 ("older")
		if q.BeforeTurn > diskLastTurn+1 && len(liveTailMsgs) > 0 {
			block = sliceHistoryBlockForRecord(rec, q.BeforeTurn)
			block.Direction = "older"
			block.HasNewer = true
		} else {
			win, err := a.store.v2.ReadBeforeTurn(a.id, q.BeforeTurn, historyBlockTokens, historyBlockMaxMessages)
			if err == nil {
				block = fromStoreWindowResult(win, "older")
				if liveExtraTurns > 0 {
					block.TotalTurns += liveExtraTurns
					block.HasNewer = true
				}
			}
		}
	}

	block.Messages = cloneMessages(block.Messages)
	block.Attachments = append([]AttachmentRef(nil), rec.Attachments...)
	block.Mode = rec.Options.Mode
	return block
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
	skippedNewer := false
	for _, g := range all {
		if beforeTurn > 0 && g.turn >= beforeTurn {
			skippedNewer = true
			continue
		}
		groups = append(groups, g)
	}
	if len(groups) == 0 {
		out.HasNewer = skippedNewer
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
	out.HasNewer = skippedNewer
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
// pages backwards from oldestTurn or forwards from newestTurn.
func historyCursorMap(block historyBlock) map[string]any {
	m := map[string]any{
		"oldestTurn": block.OldestTurn,
		"newestTurn": block.NewestTurn,
		"hasOlder":   block.HasOlder,
		"hasNewer":   block.HasNewer,
		"totalTurns": block.TotalTurns,
		"firstIndex": block.FirstIndex,
	}
	if block.TargetMsgIdx != nil {
		m["targetMsgIdx"] = *block.TargetMsgIdx
	}
	return m
}

// completionPayload is the end-of-turn session_data shape: the full
// closing metadata (usage, compaction, context, todos, model/options,
// queue, attachments, file balloons of the tail) plus ONLY the last
// completionTailTurns whole turns + cursor. Never clones or sanitizes
// full rec.Messages / rec.FileBalloons.
func completionPayload(rec *SessionRecord) map[string]any {
	block := sliceLastTurnsForRecord(rec, completionTailTurns)
	return sessionPayloadWithBlock(rec, block)
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
	block := sliceLastTurnsForRecord(rec, n)
	ev := map[string]any{
		"type":       typ,
		"hostId":     hostID,
		"sessionId":  sessionID,
		"messages":   sanitizeMessagesForFrontend(rec.Options.Mode, block.Messages, rec.Attachments),
		"compaction": compactionPayload(rec.Compaction),
		"history":    historyCursorMap(block),
	}
	for k, v := range extra {
		ev[k] = v
	}
	return ev
}
