package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Regression tests for the turn-grouping contract: zero-index messages
// attach to the FOLLOWING turn (trailing ones to the last turn) and
// belong to exactly ONE turn line — the four grouping sites
// (splitRecord, sliceTurnMessages, sliceHistoryBlock, sliceLastTurns)
// must agree, and no message may be duplicated or lost across a
// commit/restart round trip.

func grMsg(id string, role provider.Role, turn int) provider.Message {
	return provider.Message{ID: id, Role: role, TurnIndex: turn,
		Content: []provider.Content{provider.TextBlock{Text: id}}}
}

func grTL(t *testing.T, turn int, msgs ...provider.Message) turnLine {
	t.Helper()
	raw := make([]json.RawMessage, 0, len(msgs))
	for _, m := range msgs {
		b, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		raw = append(raw, b)
	}
	return turnLine{V: storeVersion, Kind: "turn", Turn: turn, Messages: raw}
}

func grIDs(msgs []provider.Message) []string {
	out := make([]string, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, m.ID)
	}
	return out
}

func TestTurnGroupsZeroAttachesToFollowing(t *testing.T) {
	// z0 between turn 1 and turn 2 belongs to turn 2 (the following
	// turn); trailing z1 belongs to the last turn; all-zero transcripts
	// group as fabricated turn 1.
	msgs := []provider.Message{
		grMsg("h", provider.RoleUser, 0),
		grMsg("a", provider.RoleUser, 1),
		grMsg("z0", provider.RoleAssistant, 0),
		grMsg("b", provider.RoleUser, 2),
		grMsg("z1", provider.RoleAssistant, 0),
	}
	got := turnGroups(msgs)
	want := []turnGroup{
		{turn: 1, idx: []int{0, 1}},
		{turn: 2, idx: []int{2, 3, 4}},
	}
	if len(got) != len(want) {
		t.Fatalf("groups = %v, want %v", got, want)
	}
	for i := range want {
		if got[i].turn != want[i].turn || len(got[i].idx) != len(want[i].idx) {
			t.Fatalf("group %d = %+v, want %+v", i, got[i], want[i])
		}
		for j := range want[i].idx {
			if got[i].idx[j] != want[i].idx[j] {
				t.Fatalf("group %d idx = %v, want %v", i, got[i].idx, want[i].idx)
			}
		}
	}

	allZero := turnGroups([]provider.Message{
		grMsg("x", provider.RoleAssistant, 0),
		grMsg("y", provider.RoleAssistant, 0),
	})
	if len(allZero) != 1 || allZero[0].turn != 1 || len(allZero[0].idx) != 2 {
		t.Fatalf("all-zero groups = %v, want single fabricated turn 1", allZero)
	}
}

func TestSliceTurnMessagesNoDuplicationAcrossTurns(t *testing.T) {
	// The historical bug: a zero-index notice between turns was included
	// in BOTH turn lines (trailing of T and leading of T+1), duplicating
	// it on disk and — because legacy IDs are per-copy — forever.
	msgs := []provider.Message{
		grMsg("a1", provider.RoleUser, 1),
		grMsg("z0", provider.RoleAssistant, 0),
		grMsg("b1", provider.RoleUser, 2),
	}
	t1 := sliceTurnMessages(msgs, 1)
	t2 := sliceTurnMessages(msgs, 2)
	if len(t1) != 1 || t1[0].ID != "a1" {
		t.Fatalf("turn 1 = %v, want just a1", grIDs(t1))
	}
	if len(t2) != 2 || t2[0].ID != "z0" || t2[1].ID != "b1" {
		t.Fatalf("turn 2 = %v, want z0,b1", grIDs(t2))
	}
	// Every message appears in exactly one turn line.
	seen := map[string]int{}
	for _, turn := range [][]provider.Message{t1, t2} {
		for _, m := range turn {
			seen[m.ID]++
		}
	}
	for _, id := range []string{"a1", "z0", "b1"} {
		if seen[id] != 1 {
			t.Fatalf("message %s appears %d times across turn lines, want 1", id, seen[id])
		}
	}
}

func TestAssembleRecordMergesSameTurnLines(t *testing.T) {
	// Two turn lines sharing a Turn must merge in order — the old
	// "last line wins" dropped the first line's messages entirely.
	lines := []turnLine{
		grTL(t, 1, grMsg("m1", provider.RoleUser, 1)),
		grTL(t, 2, grMsg("m2", provider.RoleAssistant, 2)),
		grTL(t, 2, grMsg("m3", provider.RoleAssistant, 2)),
	}
	rec := assembleRecord(lines, metaLine{V: storeVersion, Kind: "meta"})
	if got := grIDs(rec.Messages); len(got) != 3 || got[0] != "m1" || got[1] != "m2" || got[2] != "m3" {
		t.Fatalf("messages = %v, want [m1 m2 m3]", got)
	}

	// Partial then complete copy of the same message: the complete copy
	// replaces the partial one, keeping transcript position.
	partial := grMsg("m2", provider.RoleAssistant, 2)
	partial.Content = []provider.Content{provider.TextBlock{Text: "partial"}}
	full := grMsg("m2", provider.RoleAssistant, 2)
	full.Content = []provider.Content{provider.TextBlock{Text: "full content"}}
	lines2 := []turnLine{
		grTL(t, 1, grMsg("m1", provider.RoleUser, 1)),
		grTL(t, 2, partial),
		grTL(t, 2, full, grMsg("m3", provider.RoleAssistant, 2)),
	}
	rec2 := assembleRecord(lines2, metaLine{V: storeVersion, Kind: "meta"})
	if got := grIDs(rec2.Messages); len(got) != 3 || got[0] != "m1" || got[1] != "m2" || got[2] != "m3" {
		t.Fatalf("messages = %v, want [m1 m2 m3]", got)
	}
	if txt := rec2.Messages[1].Content[0].(provider.TextBlock).Text; txt != "full content" {
		t.Fatalf("merged m2 content = %q, want %q", txt, "full content")
	}
}

func TestAssembleRecordCollapsesSharedZeroIndexNoID(t *testing.T) {
	// Legacy on-disk duplicates: the same ID-less zero-index notice
	// written into two turn lines must collapse to ONE message on read
	// (fingerprint dedup across lines), while legitimate repeats inside
	// one line are kept.
	z := provider.Message{Role: provider.RoleAssistant, TurnIndex: 0,
		Content: []provider.Content{provider.TextBlock{Text: "system notice"}}}
	lines := []turnLine{
		grTL(t, 1, grMsg("a1", provider.RoleUser, 1), z),
		grTL(t, 2, z, grMsg("b1", provider.RoleUser, 2)),
	}
	rec := assembleRecord(lines, metaLine{V: storeVersion, Kind: "meta"})
	if got := grIDs(rec.Messages); len(got) != 3 {
		t.Fatalf("messages = %v, want 3 (a1, z, b1)", got)
	}
	zCount := 0
	for _, m := range rec.Messages {
		if m.TurnIndex == 0 {
			zCount++
		}
	}
	if zCount != 1 {
		t.Fatalf("zero-index copies = %d, want 1", zCount)
	}

	// Same line twice: legitimate, kept.
	rec2 := assembleRecord([]turnLine{grTL(t, 1, z, z)}, metaLine{V: storeVersion, Kind: "meta"})
	if len(rec2.Messages) != 2 {
		t.Fatalf("same-line repeat dropped: got %d messages, want 2", len(rec2.Messages))
	}
}

func TestSliceHistoryBlockSkippedTurnNoLeak(t *testing.T) {
	// beforeTurn=4 must not leak turn-4 messages into the page — the old
	// range extension dragged skipped-turn messages into the previous
	// turn's range.
	msgs := []provider.Message{
		grMsg("t1a", provider.RoleUser, 1), grMsg("t1b", provider.RoleAssistant, 1),
		grMsg("t2a", provider.RoleUser, 2), grMsg("t2b", provider.RoleAssistant, 2),
		grMsg("t3a", provider.RoleUser, 3), grMsg("t3b", provider.RoleAssistant, 3),
		grMsg("t4a", provider.RoleUser, 4), grMsg("t4b", provider.RoleAssistant, 4),
	}
	block := sliceHistoryBlock(msgs, nil, 4)
	if len(block.Messages) != 6 {
		t.Fatalf("block has %d messages, want 6", len(block.Messages))
	}
	for _, m := range block.Messages {
		if m.TurnIndex >= 4 {
			t.Fatalf("turn %d message %q leaked into beforeTurn=4 block", m.TurnIndex, m.ID)
		}
	}
	if block.FirstIndex != 0 {
		t.Fatalf("FirstIndex = %d, want 0", block.FirstIndex)
	}
	if block.OldestTurn != 1 || block.NewestTurn != 3 || block.HasOlder {
		t.Fatalf("cursor = oldest %d newest %d hasOlder %v, want 1/3/false",
			block.OldestTurn, block.NewestTurn, block.HasOlder)
	}
	if block.TotalTurns != 4 {
		t.Fatalf("TotalTurns = %d, want 4", block.TotalTurns)
	}
}

func TestSliceHistoryBlockFirstIndexAndCursor(t *testing.T) {
	// FirstIndex is the raw transcript offset of Messages[0] (the srcIdx
	// base): the frontend derives srcIdx = idx + indexBase and merges
	// tails by srcIdx < firstIndex, so a wrong offset reorders history.
	msgs := []provider.Message{
		grMsg("t1a", provider.RoleUser, 1),
		grMsg("t2a", provider.RoleUser, 2),
		grMsg("t3a", provider.RoleUser, 3),
	}
	block := sliceHistoryBlock(msgs, nil, 3) // turns 1..2
	if len(block.Messages) != 2 {
		t.Fatalf("block has %d messages, want 2", len(block.Messages))
	}
	if block.FirstIndex != 0 || block.Messages[0].ID != "t1a" {
		t.Fatalf("FirstIndex = %d first = %q, want 0/t1a", block.FirstIndex, block.Messages[0].ID)
	}
	if block.HasOlder {
		t.Fatal("HasOlder = true with the oldest turn in the block")
	}

	// A second page: beforeTurn=2 returns only turn 1.
	page := sliceHistoryBlock(msgs, nil, 2)
	if len(page.Messages) != 1 || page.Messages[0].ID != "t1a" || page.FirstIndex != 0 {
		t.Fatalf("page = %v firstIndex %d, want [t1a] at 0", grIDs(page.Messages), page.FirstIndex)
	}
	if page.HasOlder {
		t.Fatal("HasOlder = true at the transcript head")
	}
}

func TestSliceLastTurnsHeadZerosRideFirstTurn(t *testing.T) {
	// The TurnIndex-0 prefix must ride with the first block turn even
	// when the block is cut: the old code dropped it (a {0} range fell
	// outside the last-n window).
	msgs := []provider.Message{
		grMsg("h", provider.RoleUser, 0),
		grMsg("a1", provider.RoleUser, 1),
		grMsg("b1", provider.RoleUser, 2),
		grMsg("c1", provider.RoleUser, 3),
	}
	block := sliceLastTurns(msgs, nil, 2) // turns 2..3
	if len(block.Messages) != 2 || block.Messages[0].ID != "b1" || block.Messages[1].ID != "c1" {
		t.Fatalf("block = %v, want [b1 c1]", grIDs(block.Messages))
	}
	if block.FirstIndex != 2 {
		t.Fatalf("FirstIndex = %d, want 2", block.FirstIndex)
	}
	if !block.HasOlder {
		t.Fatal("HasOlder = false with turn 1 below")
	}

	// Whole-transcript window: the head zero rides with turn 1.
	full := sliceLastTurns(msgs, nil, 3)
	if len(full.Messages) != 4 || full.Messages[0].ID != "h" {
		t.Fatalf("full = %v, want [h a1 b1 c1]", grIDs(full.Messages))
	}
	if full.FirstIndex != 0 {
		t.Fatalf("FirstIndex = %d, want 0", full.FirstIndex)
	}
}

func TestCommitWALRestartNoDuplication(t *testing.T) {
	// End-to-end: a zero-index notice appended after turn 1 was committed
	// (owner-less at commit time) used to be written into BOTH the turn-1
	// and turn-2 lines on disk, and restart duplicated it in memory.
	dir := t.TempDir()
	st := newDiskStore(dir)
	sessID := "sess_gr_dup"
	now := time.Now().UnixMilli()
	rec := &SessionRecord{ID: sessID, CreatedAt: now, UpdatedAt: now}
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}

	a1 := grMsg("a1", provider.RoleUser, 1)
	rec.Messages = append(rec.Messages, a1)
	rec.TurnSeq = 1
	if err := st.commitWAL(sessID, rec, nil); err != nil {
		t.Fatal(err)
	}

	// The notice arrives after turn 1's commit: zero-index, no owner yet.
	z0 := provider.Message{Role: provider.RoleAssistant, TurnIndex: 0,
		Content: []provider.Content{provider.TextBlock{Text: "transient notice"}}}
	rec.Messages = append(rec.Messages, z0)

	// Turn 2 runs and commits: the notice must land in exactly one line.
	b1 := grMsg("b1", provider.RoleUser, 2)
	rec.Messages = append(rec.Messages, b1)
	rec.TurnSeq = 2
	if err := st.commitWAL(sessID, rec, nil); err != nil {
		t.Fatal(err)
	}

	// Restart: load from disk and count copies.
	rec2, err := st.loadSession(sessID)
	if err != nil {
		t.Fatal(err)
	}
	zCount := 0
	for _, m := range rec2.Messages {
		if m.TurnIndex == 0 {
			zCount++
		}
	}
	if zCount != 1 {
		ids := grIDs(rec2.Messages)
		t.Fatalf("zero-index copies after restart = %d, want 1 (messages %v)", zCount, ids)
	}
	if len(rec2.Messages) != 3 {
		t.Fatalf("messages after restart = %v, want 3", grIDs(rec2.Messages))
	}

	// The on-disk lines themselves must not both hold the notice.
	lines, _, err := st.readSessionFile(sessID)
	if err != nil {
		t.Fatal(err)
	}
	perLine := map[int]int{}
	for _, tl := range lines {
		for _, raw := range tl.Messages {
			m, err := core.HydrateMessageObject(raw)
			if err != nil {
				t.Fatal(err)
			}
			if m.TurnIndex == 0 {
				perLine[tl.Turn]++
			}
		}
	}
	total := 0
	for _, n := range perLine {
		total += n
	}
	if total != 1 {
		t.Fatalf("zero-index messages on disk = %d across lines %v, want 1", total, perLine)
	}

	// A second restart stays stable (no drift).
	if err := st.saveSessionSync(rec2); err != nil {
		t.Fatal(err)
	}
	rec3, err := st.loadSession(sessID)
	if err != nil {
		t.Fatal(err)
	}
	if len(rec3.Messages) != 3 {
		t.Fatalf("messages after second restart = %v, want 3", grIDs(rec3.Messages))
	}
	_ = os.Remove(filepath.Join(dir, sessID))
}

func TestSliceTurnMessagesMatchesSplitRecord(t *testing.T) {
	// The grouping sites must agree: for every turn, sliceTurnMessages
	// returns exactly the messages splitRecord writes into that turn's
	// line (order included).
	msgs := []provider.Message{
		grMsg("h", provider.RoleUser, 0),
		grMsg("a1", provider.RoleUser, 1),
		grMsg("z0", provider.RoleAssistant, 0),
		grMsg("b1", provider.RoleUser, 2),
		grMsg("b2", provider.RoleAssistant, 2),
		grMsg("z1", provider.RoleAssistant, 0),
	}
	rec := &SessionRecord{ID: "sess_gr_split", Messages: msgs}
	lines, _ := splitRecord(rec)
	if len(lines) != 2 {
		t.Fatalf("splitRecord produced %d lines, want 2", len(lines))
	}
	for _, tl := range lines {
		want := sliceTurnMessages(msgs, tl.Turn)
		if !turnLineMatches(tl, want) {
			t.Fatalf("turn %d line %v diverges from sliceTurnMessages %v",
				tl.Turn, tl.Messages, grIDs(want))
		}
	}
	// No message appears twice across the lines.
	seen := map[string]int{}
	for _, tl := range lines {
		for _, raw := range tl.Messages {
			m, err := core.HydrateMessageObject(raw)
			if err != nil {
				t.Fatal(err)
			}
			seen[m.ID]++
		}
	}
	for id, n := range seen {
		if n != 1 {
			t.Fatalf("message %s written %d times, want 1", id, n)
		}
	}
}

func TestSliceHistoryBlockBalloonsFollowTurns(t *testing.T) {
	msgs := []provider.Message{
		grMsg("a1", provider.RoleUser, 1),
		grMsg("b1", provider.RoleUser, 2),
		grMsg("c1", provider.RoleUser, 3),
	}
	balloons := []filetrack.TurnChanges{
		{TurnIndex: 1, MessageIndex: 1},
		{TurnIndex: 2, MessageIndex: 2},
		{TurnIndex: 3, MessageIndex: 3},
	}
	block := sliceHistoryBlock(msgs, balloons, 3) // turns 1..2
	if len(block.Balloons) != 2 {
		t.Fatalf("balloons = %d, want 2", len(block.Balloons))
	}
	for _, b := range block.Balloons {
		if b.TurnIndex == 3 {
			t.Fatal("turn-3 balloon leaked into beforeTurn=3 block")
		}
	}
}
