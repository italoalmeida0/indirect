package main

// Regression tests for the audit bugs fixed in the session actor /
// supervisor slice:
//
//   - Bug 2: sliceTurnMessages must concatenate ALL groups matching the
//     turn index — non-adjacent duplicate turn indices (T1, T2, T1) lost
//     the second run on commit (message loss on disk).
//   - Bug 16: a control-lane cancel arriving after quarantine must NEVER
//     wedge the session in "cancelling" (no worker exists to finalize).
//   - Bug 17: the watchdog's escalation cancel is NEVER silently dropped
//     (V2-006) — it waits for room on the control lane like the ws path.
//   - Bug 18: finishTurn applies the stashed discard&resend BEFORE the
//     queue promotion: the resend is the user's latest intent, and its
//     destructive cut must never run against a freshly promoted turn.
//   - Bug 12 follow-up: turnResumeCandidate removes stale/corrupt WALs
//     ("idle = JSON alone" invariant) instead of leaking them to disk.

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/provider"
)

// unhandledControlMsg is control-lane filler: a message type the actor
// loop consumes and ignores (control-lane saturation in tests).
type unhandledControlMsg struct{}

// TestSliceTurnMessagesKeepsNonAdjacentDuplicateTurns (Bug 2): the same
// turn index can appear in two non-adjacent runs (legacy/handoff/import
// data). sliceTurnMessages must return EVERY group matching the index,
// or the commit writes only the first run and the rest is lost on disk.
func TestSliceTurnMessagesKeepsNonAdjacentDuplicateTurns(t *testing.T) {
	msgs := []provider.Message{
		grMsg("a1", provider.RoleUser, 1),
		grMsg("b2", provider.RoleUser, 2),
		grMsg("c1", provider.RoleUser, 1), // second, non-adjacent run of turn 1
	}
	got := sliceTurnMessages(msgs, 1)
	if len(got) != 2 || got[0].ID != "a1" || got[1].ID != "c1" {
		t.Fatalf("BUG 2: turn 1 slice = %v, want a1,c1 (ALL matching groups, transcript order)", grIDs(got))
	}
	if t2 := sliceTurnMessages(msgs, 2); len(t2) != 1 || t2[0].ID != "b2" {
		t.Fatalf("turn 2 slice = %v, want b2", grIDs(t2))
	}
	// The real symptom: the commit must persist BOTH turn-1 runs. A fresh
	// session committed at turn 1 keeps every turn-1 message on disk.
	st := newDiskStore(t.TempDir())
	rec := &SessionRecord{ID: "dup-turn", TurnSeq: 1, Messages: msgs}
	if err := st.commitWAL(rec.ID, rec, nil); err != nil {
		t.Fatal(err)
	}
	fused, err := st.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, m := range fused.Messages {
		ids = append(ids, m.ID)
	}
	joined := strings.Join(ids, ",")
	if !strings.Contains(joined, "a1") || !strings.Contains(joined, "c1") {
		t.Fatalf("BUG 2: non-adjacent turn-1 runs lost on commit: on disk %v", ids)
	}
}

// TestCancelAfterQuarantineDoesNotWedgeCancelling (Bug 16): quarantine
// fences the worker (gen bump) so no workerFinishedMsg will ever call
// finishTurn. A later cancel must finalize the turn immediately instead
// of parking in stateCancel forever. Deterministic: no state polling —
// the stop() barrier proves the actor loop is idle after doCancel.
func TestCancelAfterQuarantineDoesNotWedgeCancelling(t *testing.T) {
	release := make(chan struct{})
	stuck := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		<-release // ignores ctx.Done forever (the watchdog-kill case)
	}
	act, _, _, stop := newTestActor(t, newTestRecord("qz-cancel"), stuck)
	r1 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "work", Reply: r1}}
	if res := (<-r1).(promptResult); !res.Accepted {
		t.Fatalf("prompt not accepted: %+v", res)
	}
	// Quarantine on the actor goroutine (real F3 terminal state).
	done := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.cancelRounds = maxCancelRounds
		act.doCancel("watchdog_quarantine")
		close(done)
	}}}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("quarantine hook never ran")
	}
	// Control-lane cancel AFTER quarantine (the ws route accepts it for
	// any session without checking state).
	act.control <- cancelTurnMsg{Reason: "user"}
	stop() // barrier: the actor processed the cancel before returning
	close(release)
	// State read after loop exit is race-free. Never stateCancel: there is
	// no worker left to deliver workerFinishedMsg, so "cancelling" would
	// be permanent.
	if act.state == stateCancel {
		t.Fatal("BUG 16: cancel after quarantine wedged the session in cancelling")
	}
	if act.state != stateIdle {
		t.Fatalf("cancel after quarantine must finalize the cancelled turn (idle), got %s", act.state)
	}
	if act.rec.Turn != nil && act.rec.Turn.Status == "running" {
		t.Fatalf("turn activity still running after cancel: %+v", act.rec.Turn)
	}
}

// TestWatchdogCancelWaitsForFullControlLane (Bug 17): the F3 escalation
// send must follow the ws-cancel contract — an admitted cancel is NEVER
// silently dropped. With a saturated control lane (cap 8) the send must
// block until the consumer frees a slot, and the cancel must then be
// delivered. Deterministic: a fake actor answers the watchdog ping only
// AFTER filling its own lane, so the lane is provably full at the send.
func TestWatchdogCancelWaitsForFullControlLane(t *testing.T) {
	lane := make(chan any, controlCap)
	alive := make(chan struct{}) // never closed: the handle is alive
	s := newSessionSupervisor(t.TempDir(), &configCell{}, nil, nil)
	s.resident["wedged"] = &residentEntry{handle: &sessionHandle{control: lane, done: alive}}
	// Fake actor: consumes the ping, saturates its own lane (simulating
	// pings/passivates/shutdowns piled up behind a wedged worker), and
	// only THEN answers the ping — so the lane is provably full when the
	// round reaches the escalation send.
	pingHandled := make(chan struct{})
	go func() {
		m := (<-lane).(watchdogPingMsg)
		for range controlCap {
			lane <- unhandledControlMsg{}
		}
		m.Reply <- watchdogReport{Alive: true, State: stateRunning, LastProgress: time.Now().Add(-time.Hour).UnixMilli()}
		close(pingHandled)
	}()
	roundDone := make(chan struct{})
	go func() {
		s.watchdogRound()
		close(roundDone)
	}()
	<-pingHandled // lane is full; the round is about to escalate
	// Bisect check: the escalation send must now be WAITING for room.
	// The old code had already returned here — the cancel dropped on the
	// floor (no retry, no trace) while staleRounds++ lied about progress.
	select {
	case <-roundDone:
		t.Fatal("BUG 17: watchdog round returned with the control lane full — the cancel was silently dropped (V2-006 violated)")
	case <-time.After(500 * time.Millisecond):
	}
	// Drain like a consumer: the 8 filler messages are already queued; the
	// 9th read can only complete once the blocked escalation send delivers
	// the cancel into the freed slot.
	var got cancelTurnMsg
	sawCancel := false
	total := controlCap + 1
	for range total {
		select {
		case m := <-lane:
			if c, ok := m.(cancelTurnMsg); ok {
				got, sawCancel = c, true
			}
		case <-time.After(3 * time.Second):
			t.Fatal("BUG 17: watchdog cancel never reached the control lane (silently dropped)")
		}
	}
	if !sawCancel {
		t.Fatal("BUG 17: watchdog cancel never reached the control lane")
	}
	if got.Reason != "watchdog_stale" {
		t.Fatalf("cancel reason = %q, want watchdog_stale", got.Reason)
	}
	select {
	case <-roundDone:
	case <-time.After(3 * time.Second):
		t.Fatal("watchdog round did not return after the cancel was delivered")
	}
}

// TestFinishTurnAppliesResendStashBeforeQueuePromotion (Bug 18): a
// queue_send_now promotion and a stashed discard&resend race the same
// finalizer. The resend is the user's latest intent: it must run FIRST,
// start ITS turn, and the queue item must stay queued (not consumed by a
// doomed promotion). The old order promoted the queue head first, ran the
// stash's destructive cut against the freshly promoted turn (persisted!),
// and then lost the edit ("session is busy").
func TestFinishTurnAppliesResendStashBeforeQueuePromotion(t *testing.T) {
	rec := &SessionRecord{ID: "sess-finish", Messages: darMsgs(4), Queue: []QueuedMessage{
		{ID: "q1", Text: "queued prompt", CreatedAt: 1},
	}}
	a, st := darActor(t, rec)
	// Fake the running turn that sendNow + discard_and_resend race on.
	a.state = stateRunning
	a.rec.Turn = &TurnActivity{StartedAt: time.Now().UnixMilli(), Status: "running"}
	a.rec.TurnSeq = 2
	a.workerDone = make(chan struct{})
	// queue_send_now on the running turn: flags the item for promotion.
	a.onQueueSendNow(queueSendNowMsg{QueueID: "q1"})
	if !a.sendNow || len(a.rec.Queue) != 1 {
		t.Fatalf("sendNow setup failed: sendNow=%v queue=%d", a.sendNow, len(a.rec.Queue))
	}
	// discard_and_resend on turn 2 while the turn runs: stash + cancel.
	reply := make(chan any, 1)
	a.onDiscardAndResend(discardAndResendMsg{TurnID: 2, Text: "MY EDITED TEXT", Reply: reply})
	if a.pendingResend == nil {
		t.Fatal("discard_and_resend must be stashed until the running turn gives way")
	}
	// The finalizer (buggy order: promote head first, apply stash after).
	a.finishTurn(false)
	select {
	case r := <-reply:
		if dr := r.(discardResendResult); dr.Error != "" {
			t.Fatalf("BUG 18: stashed edit lost: %s", dr.Error)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("BUG 18: stashed resend never answered")
	}
	// The edit owns the session: ITS seeded turn is running (turn 2).
	if a.state != stateRunning {
		t.Fatalf("edit's seeded turn must be running, state=%s", a.state)
	}
	if a.rec.TurnSeq != 2 {
		t.Fatalf("the promoted queue head started a competing turn (TurnSeq=%d)", a.rec.TurnSeq)
	}
	// The queue item is NOT consumed by a doomed promotion.
	if len(a.rec.Queue) != 1 || a.rec.Queue[0].Text != "queued prompt" {
		t.Fatalf("queue item lost to a dead promotion: %+v", a.rec.Queue)
	}
	// Durable contract: the edit landed and the transcript was NOT cut
	// against the promoted turn (turn 1 intact, turn 2 = the new row only).
	fused, _, err := st.loadSessionFused("sess-finish")
	if err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, m := range fused.Messages {
		for _, c := range m.Content {
			if tb, ok := c.(provider.TextBlock); ok {
				texts = append(texts, tb.Text)
			}
		}
	}
	joined := strings.Join(texts, "|")
	if !strings.Contains(joined, "MY EDITED TEXT") {
		t.Fatalf("BUG 18: edit lost on disk: %v", texts)
	}
	if !strings.Contains(joined, "m0") || !strings.Contains(joined, "m1") {
		t.Fatalf("BUG 18: destructive cut ran against the promoted turn: %v", texts)
	}
	if strings.Contains(joined, "m2") || strings.Contains(joined, "m3") {
		t.Fatalf("stale tail of the edited turn survived: %v", texts)
	}
}

// TestTurnResumeCandidateRemovesStaleWAL (Bug 12 follow-up): a WAL whose
// turn was already committed and a corrupt WAL can never be resumed —
// turnResumeCandidate must remove them ("idle = JSON alone"), not leak
// them for every loadSessionFused to replay.
func TestTurnResumeCandidateRemovesStaleWAL(t *testing.T) {
	st := newDiskStore(t.TempDir())
	rec := &SessionRecord{ID: "wal-clean", TurnSeq: 2, Messages: darMsgs(2)}
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	// Stale WAL: header turn 1 < TurnSeq 2 (already committed).
	ww, err := st.openWAL("wal-clean", &walHeader{TurnIndex: 1, StartedAt: 1, Prompt: "dead"})
	if err != nil {
		t.Fatal(err)
	}
	_ = ww.close()
	if header, _ := turnResumeCandidate(rec, st, "wal-clean"); header != nil {
		t.Fatalf("stale WAL must not resume: %+v", header)
	}
	if _, err := os.Stat(st.walPath("wal-clean")); !os.IsNotExist(err) {
		t.Fatal("BUG 12: stale WAL (header.TurnIndex < rec.TurnSeq) survives on disk")
	}
	// Corrupt WAL: interior garbage is fail-closed and never resumable.
	ww, err = st.openWAL("wal-clean", &walHeader{TurnIndex: 2, StartedAt: 1, Prompt: "work"})
	if err != nil {
		t.Fatal(err)
	}
	_ = ww.close()
	data, err := os.ReadFile(st.walPath("wal-clean"))
	if err != nil {
		t.Fatal(err)
	}
	corrupt := append([]byte(nil), data...)
	corrupt = append(corrupt, []byte("GARBAGE-NOT-JSON\n")...)
	corrupt = append(corrupt, []byte(`{"v":1,"type":"meta","updatedAt":1}`+"\n")...)
	if err := os.WriteFile(st.walPath("wal-clean"), corrupt, 0o600); err != nil {
		t.Fatal(err)
	}
	if header, _ := turnResumeCandidate(rec, st, "wal-clean"); header != nil {
		t.Fatalf("corrupt WAL must not resume: %+v", header)
	}
	if _, err := os.Stat(st.walPath("wal-clean")); !os.IsNotExist(err) {
		t.Fatal("BUG 12: corrupt WAL survives turnResumeCandidate (session would stay running forever)")
	}
}

// TestSupervisorPurgeRemovesBgBookkeeping (Bug 20 wiring): the purge
// cascade (sessionAdmin.purgeSession → sessionSupervisor.purge) must not
// leak the purged session's background bookkeeping — bg/<job>.pid.json and
// bg/<job>.notice.json would otherwise stay orphaned forever and get
// re-delivered to a session that no longer exists. Other sessions' files
// must survive.
func TestSupervisorPurgeRemovesBgBookkeeping(t *testing.T) {
	dir := t.TempDir()
	bg := newBGSupervisor(dir)
	s := newSessionSupervisor(dir, &configCell{}, nil, bg)
	write := func(jobID, sessionID string) (string, string) {
		if err := bg.writePidfile(&bgJob{
			ID: jobID, SessionID: sessionID, Kind: "bash", Label: "probe",
			PID: 4242, Identity: "id-" + jobID, StartedAt: 1, LogPath: "out.log",
		}); err != nil {
			t.Fatal(err)
		}
		bg.retainNotice(jobID, sessionID, "finished", true)
		return bg.pidPath(jobID), bg.noticePath(jobID)
	}
	deadPID, deadNotice := write("bg_dead", "sess_del")
	keepPID, keepNotice := write("bg_keep", "sess_keep")

	if err := s.purge("sess_del"); err != nil {
		t.Fatal(err)
	}

	for _, p := range []string{deadPID, deadNotice} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("BUG 20: purged session's bookkeeping survived purge: %s (%v)", p, err)
		}
	}
	for _, p := range []string{keepPID, keepNotice} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("other session's bookkeeping must survive purge: %s (%v)", p, err)
		}
	}
}
