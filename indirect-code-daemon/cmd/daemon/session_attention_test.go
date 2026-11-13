package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/agent/tools"
	"indirect/indirect-code-daemon/packages/provider"
)

func waitActorState(t *testing.T, act *sessionActor, want string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		rep := (<-repCh).(watchdogReport)
		if rep.State == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for actor state %q (have %q)", want, rep.State)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func readActorRecord(t *testing.T, act *sessionActor) *SessionRecord {
	t.Helper()
	ch := make(chan any, 1)
	act.inbox <- Envelope{Payload: readReqMsg{What: "data", Reply: ch}}
	res := (<-ch).(readResult)
	if res.Error != "" {
		t.Fatalf("readReqMsg failed: %s", res.Error)
	}
	return res.Payload.(*SessionRecord)
}

func readActorSummary(t *testing.T, act *sessionActor) map[string]any {
	t.Helper()
	ch := make(chan any, 1)
	act.inbox <- Envelope{Payload: readReqMsg{What: "summary", Reply: ch}}
	res := (<-ch).(readResult)
	if res.Error != "" {
		t.Fatalf("readReqMsg summary failed: %s", res.Error)
	}
	return res.Payload.(map[string]any)
}

func TestAttentionLegacyZeroMigrationAndOmitEmpty(t *testing.T) {
	dir := t.TempDir()
	writeV1Session(t, dir, "legacy1", "idle", 1, 1)
	st := newDiskStore(dir)

	meta, err := st.readMetaTail("legacy1")
	if err != nil {
		t.Fatal(err)
	}
	if meta.AttentionSeq != 0 || meta.SeenSeq != 0 || meta.AttentionKind != "" {
		t.Fatalf("legacy meta decoded non-zero watermarks: %+v", meta)
	}
	rec, err := st.loadSession("legacy1")
	if err != nil {
		t.Fatal(err)
	}
	if rec.AttentionSeq != 0 || rec.SeenSeq != 0 || rec.AttentionKind != "" {
		t.Fatalf("legacy session decoded non-zero watermarks: %+v", rec)
	}

	// Saving zero-valued watermarks keeps the on-disk meta line compact (omitempty).
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(st.sessionFile("legacy1"))
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"attentionSeq"`, `"seenSeq"`, `"attentionKind"`} {
		if strings.Contains(string(raw), key) {
			t.Fatalf("expected %s to be omitted when zero, got raw:\n%s", key, string(raw))
		}
	}
}

func TestAttentionTurnOutcomes(t *testing.T) {
	dir := t.TempDir()
	store := newDiskStore(dir)
	var pings atomic.Int64
	var wsMu sync.Mutex
	var wsEvents []map[string]any

	var mode atomic.Int32 // 0=ok, 1=fail, 2=block-until-cancel, 3=wedged(ignore ctx)
	wedgedRelease := make(chan struct{})
	defer close(wedgedRelease)

	rec := newTestRecord("outcomes")
	act := newSessionActor(rec.ID, rec, store, func(ev any) {
		if m, ok := ev.(map[string]any); ok {
			wsMu.Lock()
			wsEvents = append(wsEvents, m)
			wsMu.Unlock()
		}
	}, nil, func(col string) {
		if col == "sessions" {
			pings.Add(1)
		}
	})
	act.startWorker = func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		switch mode.Load() {
		case 0:
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
		case 1:
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, err: "provider 500"}, Epoch: snap.epoch}
		case 2:
			<-ctx.Done()
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, cancelled: true}, Epoch: snap.epoch}
		case 3:
			<-wedgedRelease
		}
	}
	go act.run()
	defer func() { act.control <- shutdownMsg{}; <-act.done }()

	// 1. Normal turn completion -> attentionSeq=1, seenSeq=0, attentionKind="completed".
	mode.Store(0)
	r1 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "hello", Reply: r1}}
	if res := (<-r1).(promptResult); !res.Accepted {
		t.Fatalf("turn 1 rejected: %+v", res)
	}
	waitActorState(t, act, stateIdle)

	got := readActorRecord(t, act)
	if got.AttentionSeq != 1 || got.SeenSeq != 0 || got.AttentionKind != "completed" {
		t.Fatalf("after completed turn: got att=%d seen=%d kind=%q", got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}
	sum := readActorSummary(t, act)
	if sum["attentionSeq"] != int64(1) || sum["seenSeq"] != int64(0) || sum["attentionKind"] != "completed" {
		t.Fatalf("summary mismatch: %+v", sum)
	}
	payload := sessionPayload(got)
	if payload["attentionSeq"] != int64(1) || payload["seenSeq"] != int64(0) || payload["attentionKind"] != "completed" {
		t.Fatalf("sessionPayload mismatch: %+v", payload)
	}
	diskRec, err := store.loadSession("outcomes")
	if err != nil {
		t.Fatal(err)
	}
	if diskRec.AttentionSeq != 1 || diskRec.SeenSeq != 0 || diskRec.AttentionKind != "completed" {
		t.Fatalf("disk reload mismatch: att=%d seen=%d kind=%q", diskRec.AttentionSeq, diskRec.SeenSeq, diskRec.AttentionKind)
	}

	// 2. Starting turn 2 marks turn 1 seen (seenSeq=1, kind=""), then failure bumps att=2, kind="error".
	mode.Store(1)
	r2 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "boom", Reply: r2}}
	if res := (<-r2).(promptResult); !res.Accepted {
		t.Fatalf("turn 2 rejected: %+v", res)
	}
	waitActorState(t, act, stateIdle)

	got = readActorRecord(t, act)
	if got.AttentionSeq != 2 || got.SeenSeq != 1 || got.AttentionKind != "error" {
		t.Fatalf("after failed turn: got att=%d seen=%d kind=%q", got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}

	// 3. User Stop ("user") marks seen on prompt start (seen=2) and does NOT bump unread on stop,
	// even if a watchdog_stale tick arrives while cancelling.
	hold := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.startWorker = func(snap workerSnapshot, env workerEnv, ctx context.Context) {
			<-ctx.Done()
			<-hold
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, cancelled: true}, Epoch: snap.epoch}
		}
	}}}
	r3 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "stop me", Reply: r3}}
	if res := (<-r3).(promptResult); !res.Accepted {
		t.Fatalf("turn 3 rejected: %+v", res)
	}
	waitActorState(t, act, stateRunning)
	act.control <- cancelTurnMsg{Reason: "user"}
	waitActorState(t, act, stateCancel)
	// Simulate concurrent watchdog tick while worker is unwinding.
	act.control <- cancelTurnMsg{Reason: "watchdog_stale"}
	close(hold)
	waitActorState(t, act, stateIdle)

	got = readActorRecord(t, act)
	if got.AttentionSeq != 2 || got.SeenSeq != 2 || got.AttentionKind != "" {
		t.Fatalf("user Stop must not leave session unread: got att=%d seen=%d kind=%q", got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}

	// 4. Non-user watchdog stale cancel -> att=3, seen=2, kind="cancelled".
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.startWorker = func(snap workerSnapshot, env workerEnv, ctx context.Context) {
			<-ctx.Done()
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, cancelled: true}, Epoch: snap.epoch}
		}
	}}}
	r4 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "stale turn", Reply: r4}}
	if res := (<-r4).(promptResult); !res.Accepted {
		t.Fatalf("turn 4 rejected: %+v", res)
	}
	waitActorState(t, act, stateRunning)
	act.control <- cancelTurnMsg{Reason: "watchdog_stale"}
	waitActorState(t, act, stateIdle)

	got = readActorRecord(t, act)
	if got.AttentionSeq != 3 || got.SeenSeq != 2 || got.AttentionKind != "cancelled" {
		t.Fatalf("watchdog_stale cancel: got att=%d seen=%d kind=%q", got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}

	// 5. Quarantine escalation -> user prompt marks seen=3, then quarantine bumps att=4, kind="error".
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.startWorker = func(snap workerSnapshot, env workerEnv, ctx context.Context) {
			<-wedgedRelease
		}
	}}}
	r5 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "wedged", Reply: r5}}
	if res := (<-r5).(promptResult); !res.Accepted {
		t.Fatalf("turn 5 rejected: %+v", res)
	}
	waitActorState(t, act, stateRunning)
	for i := 0; i < maxCancelRounds; i++ {
		reason := "watchdog_stale"
		if i == maxCancelRounds-1 {
			reason = "watchdog_quarantine"
		}
		act.control <- cancelTurnMsg{Reason: reason}
	}
	waitActorState(t, act, stateOrphaned)

	got = readActorRecord(t, act)
	if got.Status != "orphaned" || got.AttentionSeq != 4 || got.SeenSeq != 3 || got.AttentionKind != "error" {
		t.Fatalf("quarantine attention mismatch: status=%q att=%d seen=%d kind=%q", got.Status, got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}
}

func TestAttentionMidTurnApprovalQuestionAndTimeouts(t *testing.T) {
	dir := t.TempDir()
	store := newDiskStore(dir)
	var pings atomic.Int64
	var wsMu sync.Mutex
	var wsEvents []map[string]any

	release := make(chan struct{})
	rec := newTestRecord("midturn")
	rec.Options.Mode = "build"
	act := newSessionActor(rec.ID, rec, store, func(ev any) {
		if m, ok := ev.(map[string]any); ok {
			wsMu.Lock()
			wsEvents = append(wsEvents, m)
			wsMu.Unlock()
		}
	}, nil, func(col string) {
		if col == "sessions" {
			pings.Add(1)
		}
	})
	act.startWorker = func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		select {
		case <-release:
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
		case <-ctx.Done():
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, cancelled: true}, Epoch: snap.epoch}
		}
	}
	go act.run()
	defer func() { act.control <- shutdownMsg{}; <-act.done }()

	r1 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "need approval", Reply: r1}}
	if res := (<-r1).(promptResult); !res.Accepted {
		t.Fatal(res)
	}
	waitActorState(t, act, stateRunning)

	// 1. Enter approval await: status stays "running", att=1 > seen=0, kind="approval", WAL + pingChange.
	beforePings := pings.Load()
	apprWaiter := make(chan approvalOutcome, 1)
	entered := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.approvalWaiters["ap_1"] = apprWaiter
		act.enterAwait("approval", "ap_1", nil)
		act.pending.tool = "bash"
		close(entered)
	}}}
	<-entered
	waitActorState(t, act, stateAwaitAppr)

	if pings.Load() <= beforePings {
		t.Fatalf("expected pingChange on enterAwait(approval)")
	}
	got := readActorRecord(t, act)
	if got.Status != "running" || got.AttentionSeq != 1 || got.SeenSeq != 0 || got.AttentionKind != "approval" {
		t.Fatalf("mid-turn approval mismatch: status=%q att=%d seen=%d kind=%q", got.Status, got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}

	// Verify WAL replay carries mid-turn approval attention AND crash-recovery enterAwait does NOT double-increment.
	fused, _, err := store.loadSessionFused("midturn")
	if err != nil {
		t.Fatal(err)
	}
	if fused.AttentionSeq != 1 || fused.SeenSeq != 0 || fused.AttentionKind != "approval" {
		t.Fatalf("WAL replay mismatch: att=%d seen=%d kind=%q", fused.AttentionSeq, fused.SeenSeq, fused.AttentionKind)
	}
	recovDir := t.TempDir()
	recovActor := newSessionActor("recov", fused, newDiskStore(recovDir), nil, nil, nil)
	recovActor.enterAwait("approval", "ap_1", nil)
	if recovActor.pending != nil && recovActor.pending.timer != nil {
		recovActor.pending.timer.Stop()
	}
	if recovActor.rec.AttentionSeq != 1 || recovActor.rec.AttentionKind != "approval" {
		t.Fatalf("crash recovery enterAwait double-incremented: att=%d kind=%q", recovActor.rec.AttentionSeq, recovActor.rec.AttentionKind)
	}

	// 2. Answering approval with Always=true resolves mid-turn attention across mirror + session_data.
	beforePings = pings.Load()
	act.inbox <- Envelope{Payload: approvalResponseMsg{ID: "ap_1", Approved: true, Always: true}}
	out := <-apprWaiter
	if !out.approved {
		t.Fatalf("expected approval granted: %+v", out)
	}
	waitActorState(t, act, stateRunning)
	got = readActorRecord(t, act)
	if got.Status != "running" || got.AttentionSeq != 1 || got.SeenSeq != 1 || got.AttentionKind != "" {
		t.Fatalf("after approval response: status=%q att=%d seen=%d kind=%q", got.Status, got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}
	if pings.Load() <= beforePings {
		t.Fatalf("expected pingChange on approval resolution")
	}
	wsMu.Lock()
	var alwaysSession map[string]any
	for i := len(wsEvents) - 1; i >= 0; i-- {
		if wsEvents[i]["type"] == "session_data" {
			alwaysSession, _ = wsEvents[i]["session"].(map[string]any)
			break
		}
	}
	wsMu.Unlock()
	if alwaysSession == nil || alwaysSession["seenSeq"] != int64(1) || alwaysSession["attentionKind"] != "" {
		t.Fatalf("Always-allow session_data must carry cleared attention: %+v", alwaysSession)
	}

	// 3. Mid-turn question: invalid answer keeps unread; viewing via markSeenMsg clears unread while running;
	// answering afterwards does not bump; a second question auto-proceeding on 15m timeout clears unread!
	qWaiter1 := make(chan questionOutcome, 1)
	qEntered := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.questionWaiters["q_1"] = qWaiter1
		act.enterAwait("question", "q_1", [][]string{{"Yes"}})
		act.pending.question = &tools.QuestionRequest{
			Questions: []tools.Question{{
				Question: "Continue?",
				Options:  []tools.QuestionOption{{Label: "Yes"}, {Label: "No"}},
			}},
		}
		close(qEntered)
	}}}
	<-qEntered
	waitActorState(t, act, stateAwaitQ)

	got = readActorRecord(t, act)
	if got.AttentionSeq != 2 || got.SeenSeq != 1 || got.AttentionKind != "question" {
		t.Fatalf("question await mismatch: att=%d seen=%d kind=%q", got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}

	// Invalid answer (wrong question count) must NOT clear unread.
	act.inbox <- Envelope{Payload: questionResponseMsg{ID: "q_1", Answers: [][]string{}}}
	got = readActorRecord(t, act)
	if got.AttentionSeq != 2 || got.SeenSeq != 1 || got.AttentionKind != "question" {
		t.Fatalf("invalid question answer cleared unread: att=%d seen=%d kind=%q", got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}

	// Viewing mid-turn via markSeenMsg clears unread while keeping status=="running" and stateAwaitQ!
	updatedBeforeSeen := got.UpdatedAt
	act.inbox <- Envelope{Payload: markSeenMsg{Seq: 2}}
	got = readActorRecord(t, act)
	if got.Status != "running" || got.AttentionSeq != 2 || got.SeenSeq != 2 || got.AttentionKind != "" {
		t.Fatalf("mid-turn markSeen mismatch: status=%q att=%d seen=%d kind=%q", got.Status, got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}
	if got.UpdatedAt != updatedBeforeSeen {
		t.Fatalf("mid-turn markSeen mutated UpdatedAt: got %d want %d", got.UpdatedAt, updatedBeforeSeen)
	}
	fusedSeen, _, err := store.loadSessionFused("midturn")
	if err != nil {
		t.Fatal(err)
	}
	if fusedSeen.SeenSeq != 2 || fusedSeen.AttentionKind != "" || fusedSeen.UpdatedAt != updatedBeforeSeen {
		t.Fatalf("WAL replay after mid-turn markSeen mismatch: seen=%d kind=%q updatedAt=%d (want %d)",
			fusedSeen.SeenSeq, fusedSeen.AttentionKind, fusedSeen.UpdatedAt, updatedBeforeSeen)
	}

	// Now answer q_1 validly.
	act.inbox <- Envelope{Payload: questionResponseMsg{ID: "q_1", Answers: [][]string{{"Yes"}}}}
	qOut1 := <-qWaiter1
	if len(qOut1.answers) != 1 || qOut1.answers[0][0] != "Yes" {
		t.Fatalf("unexpected question outcome: %+v", qOut1)
	}
	waitActorState(t, act, stateRunning)

	// Enter q_2 and trigger 15m question auto-proceed (stateTimeoutMsg) WITHOUT viewing first -> clears unread!
	qWaiter2 := make(chan questionOutcome, 1)
	q2Entered := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.questionWaiters["q_2"] = qWaiter2
		act.enterAwait("question", "q_2", [][]string{{"Recommended"}})
		close(q2Entered)
	}}}
	<-q2Entered
	got = readActorRecord(t, act)
	if got.AttentionSeq != 3 || got.SeenSeq != 2 || got.AttentionKind != "question" {
		t.Fatalf("q_2 enter mismatch: att=%d seen=%d kind=%q", got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}
	act.inbox <- Envelope{Payload: stateTimeoutMsg{ID: "q_2"}}
	<-qWaiter2
	waitActorState(t, act, stateRunning)
	got = readActorRecord(t, act)
	if got.AttentionSeq != 3 || got.SeenSeq != 3 || got.AttentionKind != "" {
		t.Fatalf("question 15m auto-proceed must clear unread: att=%d seen=%d kind=%q", got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}

	// Enter ap_2, view it (seen=4), then let approval 15m timeout fire -> turn cancels and bumps att=5, kind="cancelled"!
	ap2Entered := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.enterAwait("approval", "ap_2", nil)
		close(ap2Entered)
	}}}
	<-ap2Entered
	act.inbox <- Envelope{Payload: markSeenMsg{Seq: 4}}
	got = readActorRecord(t, act)
	if got.AttentionSeq != 4 || got.SeenSeq != 4 || got.AttentionKind != "" {
		t.Fatalf("ap_2 markSeen mismatch: att=%d seen=%d kind=%q", got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}
	act.inbox <- Envelope{Payload: stateTimeoutMsg{ID: "ap_2"}}
	waitActorState(t, act, stateIdle)
	close(release)

	got = readActorRecord(t, act)
	if got.AttentionSeq != 5 || got.SeenSeq != 4 || got.AttentionKind != "cancelled" {
		t.Fatalf("approval timeout must bump cancelled attention: att=%d seen=%d kind=%q", got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}
}

func TestAttentionMarkSessionSeenClampingIdempotencyAndWS(t *testing.T) {
	traceRoot := withTrace(t)
	h := newWSHarness(t)
	var pings atomic.Int64
	prevNotify := h.sup.notifyFn
	h.sup.notifyFn = func(c string) {
		if c == "sessions" {
			pings.Add(1)
		}
		if prevNotify != nil {
			prevNotify(c)
		}
	}

	st := newDiskStore(h.dir)
	const fixedUpdatedAt int64 = 1700000123456
	rec := &SessionRecord{
		ID:            "clamp1",
		CWD:           "/tmp",
		Title:         "Clamp Test",
		Model:         "m",
		Status:        "idle",
		CreatedAt:     1700000000000,
		UpdatedAt:     fixedUpdatedAt,
		TurnSeq:       3,
		AttentionSeq:  3,
		SeenSeq:       0,
		AttentionKind: "completed",
		Messages: []provider.Message{
			{ID: "m1", Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "hi"}}},
		},
	}
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}

	// 1. In-flight stale ack (seenSeq=2 < attentionSeq=3) clamps to 2, keeps unread & attentionKind="completed", preserves UpdatedAt.
	beforePings := pings.Load()
	h.send(map[string]any{"type": "mark_session_seen", "sessionId": "clamp1", "seenSeq": 2})
	h.server.waitForLanes()

	deadline := time.Now().Add(2 * time.Second)
	for pings.Load() == beforePings && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if pings.Load() == beforePings {
		t.Fatalf("expected pingChange for clamped mark_session_seen")
	}

	meta, err := st.readMetaTail("clamp1")
	if err != nil {
		t.Fatal(err)
	}
	if meta.AttentionSeq != 3 || meta.SeenSeq != 2 || meta.AttentionKind != "completed" {
		t.Fatalf("clamped mark_session_seen mismatch: att=%d seen=%d kind=%q", meta.AttentionSeq, meta.SeenSeq, meta.AttentionKind)
	}
	if meta.UpdatedAt != fixedUpdatedAt {
		t.Fatalf("mark_session_seen mutated UpdatedAt: got %d want %d", meta.UpdatedAt, fixedUpdatedAt)
	}

	// 2. Idempotent repeat (seenSeq=2 and seenSeq=1 <= current SeenSeq=2): ZERO disk write, ZERO pingChange!
	filePath := st.sessionFile("clamp1")
	if _, err := os.Stat(filePath); os.IsNotExist(err) && st.v2.HasV2Session("clamp1") {
		filePath = filepath.Join(st.sessionsDir(), "clamp1", "meta.json")
	}
	backdated := time.Unix(1700000000, 0)
	if err := os.Chtimes(filePath, backdated, backdated); err != nil {
		t.Fatal(err)
	}
	pingsBeforeNoop := pings.Load()
	h.send(map[string]any{"type": "mark_session_seen", "sessionId": "clamp1", "seenSeq": 2})
	h.send(map[string]any{"type": "mark_session_seen", "sessionId": "clamp1", "seenSeq": 1})
	h.server.waitForLanes()
	// Flush through actor inbox with a get_session barrier.
	h.send(map[string]any{"type": "get_session", "sessionId": "clamp1", "requestId": "barrier1"})
	if h.lastType("session_data") == nil {
		t.Fatalf("no session_data for barrier1")
	}
	if pings.Load() != pingsBeforeNoop {
		t.Fatalf("idempotent mark_session_seen emitted %d unexpected pings", pings.Load()-pingsBeforeNoop)
	}
	info, err := os.Stat(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(backdated) {
		t.Fatalf("idempotent mark_session_seen rewrote session file (mtime=%v want=%v)", info.ModTime(), backdated)
	}

	// 3. Fallback "seq" field (and seq > attentionSeq clamp) catches up to 3 and clears attentionKind="".
	h.send(map[string]any{"type": "mark_session_seen", "sessionId": "clamp1", "seq": 99})
	h.server.waitForLanes()
	h.send(map[string]any{"type": "get_session", "sessionId": "clamp1", "requestId": "barrier2"})
	deadline = time.Now().Add(2 * time.Second)
	for {
		m, err := st.readMetaTail("clamp1")
		if err == nil && m.SeenSeq == 3 {
			if m.AttentionKind != "" || m.UpdatedAt != fixedUpdatedAt {
				t.Fatalf("caught-up meta mismatch: %+v", m)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("mark_session_seen seq fallback did not persist")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// 4. Purged session must NOT resurrect .jsonl when mark_session_seen arrives!
	if err := h.admin.purgeSession("clamp1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Fatalf("session file still exists after purge: %v", err)
	}
	h.send(map[string]any{"type": "mark_session_seen", "sessionId": "clamp1", "seenSeq": 3})
	h.server.waitForLanes()
	time.Sleep(50 * time.Millisecond)
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Fatalf("mark_session_seen resurrected purged session file!")
	}
	if err := st.rewriteMetaOnly("clamp1", metaLine{ID: "clamp1", Status: "idle"}); err != errSessionPurged {
		t.Fatalf("rewriteMetaOnly must reject purged tombstone, got %v", err)
	}

	// 5. Cold quarantined session can still be marked seen via WS without starting a new turn.
	qRec := &SessionRecord{
		ID:            "quar_cold",
		CWD:           "/tmp",
		Title:         "Quarantined",
		Model:         "m",
		Status:        "orphaned",
		CreatedAt:     1,
		UpdatedAt:     fixedUpdatedAt,
		AttentionSeq:  1,
		SeenSeq:       0,
		AttentionKind: "error",
	}
	if err := st.saveSessionSync(qRec); err != nil {
		t.Fatal(err)
	}
	h.send(map[string]any{"type": "mark_session_seen", "sessionId": "quar_cold", "seenSeq": 1})
	h.server.waitForLanes()
	deadline = time.Now().Add(2 * time.Second)
	for {
		qm, err := st.readMetaTail("quar_cold")
		if err == nil && qm.SeenSeq == 1 {
			if qm.AttentionKind != "" || qm.Status != "orphaned" || qm.UpdatedAt != fixedUpdatedAt {
				t.Fatalf("quarantined mark_session_seen mismatch: %+v", qm)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("cold quarantined session was not marked seen")
		}
		time.Sleep(10 * time.Millisecond)
	}

	traceRecs := traceFile(t, filepath.Join(traceRoot, "trace"))
	foundTrace := false
	for _, tr := range traceRecs {
		if tr["ev"] == "actor.attention" {
			foundTrace = true
			break
		}
	}
	if !foundTrace {
		t.Fatalf("expected actor.attention trace event from mark_session_seen")
	}
}

func TestAttentionQueuePromoteInterruptAndBgNotice(t *testing.T) {
	// Part A: Queue promotion (shouldPromote) must NOT bump "completed" on intermediate turn boundaries.
	turn1Hold := make(chan struct{})
	turn2Hold := make(chan struct{})
	var started atomic.Int32
	rec := newTestRecord("qchain")
	act, _, _, stop := newTestActor(t, rec, func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		n := started.Add(1)
		if n == 1 {
			<-turn1Hold
		} else if n == 2 {
			<-turn2Hold
		}
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
	})
	defer stop()

	r1 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "step 1", Reply: r1}}
	if res := (<-r1).(promptResult); !res.Accepted {
		t.Fatal(res)
	}
	r2 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "step 2", MidTurnDelivery: "queue", Reply: r2}}
	if res := (<-r2).(promptResult); !res.Accepted || !res.Queued {
		t.Fatalf("expected queued step 2: %+v", res)
	}

	// Release Turn 1: Turn 2 promotes immediately. While Turn 2 runs, AttentionSeq must still be 0!
	close(turn1Hold)
	deadline := time.Now().Add(3 * time.Second)
	for started.Load() < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("turn 2 did not promote")
		}
		time.Sleep(10 * time.Millisecond)
	}
	mid := readActorRecord(t, act)
	if mid.Status != "running" || mid.AttentionSeq != 0 || mid.SeenSeq != 0 || mid.AttentionKind != "" {
		t.Fatalf("intermediate promoted turn must not bump completed: status=%q att=%d seen=%d kind=%q",
			mid.Status, mid.AttentionSeq, mid.SeenSeq, mid.AttentionKind)
	}

	// Release Turn 2: queue is now empty, so completion bumps AttentionSeq=1, AttentionKind="completed".
	close(turn2Hold)
	waitActorState(t, act, stateIdle)
	done := readActorRecord(t, act)
	if done.AttentionSeq != 1 || done.SeenSeq != 0 || done.AttentionKind != "completed" {
		t.Fatalf("final queued turn must bump completed: att=%d seen=%d kind=%q",
			done.AttentionSeq, done.SeenSeq, done.AttentionKind)
	}

	// Part A2: interrupt_and_send while running cancels Turn 3, promotes Turn 4 with SeenSeq==AttentionSeq,
	// and bumps AttentionSeq=2 only when Turn 4 completes!
	turn3Hold := make(chan struct{})
	turn4Hold := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.startWorker = func(snap workerSnapshot, env workerEnv, ctx context.Context) {
			n := started.Add(1)
			if n == 3 {
				select {
				case <-turn3Hold:
					env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
				case <-ctx.Done():
					env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, cancelled: true}, Epoch: snap.epoch}
				}
				return
			}
			<-turn4Hold
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
		}
	}}}
	r3 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "step 3", Reply: r3}}
	if res := (<-r3).(promptResult); !res.Accepted {
		t.Fatal(res)
	}
	for started.Load() < 3 {
		time.Sleep(10 * time.Millisecond)
	}
	r4 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "step 4 interrupt", MidTurnDelivery: "interrupt", Reply: r4}}
	if res := (<-r4).(promptResult); !res.Accepted || !res.Interrupting {
		t.Fatalf("expected interrupting step 4: %+v", res)
	}
	for started.Load() < 4 {
		if time.Now().After(deadline) {
			t.Fatalf("turn 4 did not promote on interrupt")
		}
		time.Sleep(10 * time.Millisecond)
	}
	midInt := readActorRecord(t, act)
	if midInt.Status != "running" || midInt.AttentionSeq != 1 || midInt.SeenSeq != 1 || midInt.AttentionKind != "" {
		t.Fatalf("interrupt_and_send promoted turn mismatch: status=%q att=%d seen=%d kind=%q",
			midInt.Status, midInt.AttentionSeq, midInt.SeenSeq, midInt.AttentionKind)
	}
	close(turn3Hold)
	close(turn4Hold)
	waitActorState(t, act, stateIdle)
	doneInt := readActorRecord(t, act)
	if doneInt.AttentionSeq != 2 || doneInt.SeenSeq != 1 || doneInt.AttentionKind != "completed" {
		t.Fatalf("after interrupted+promoted turn finishes: att=%d seen=%d kind=%q",
			doneInt.AttentionSeq, doneInt.SeenSeq, doneInt.AttentionKind)
	}

	// Part B: onBgNotice autonomous runner wake MUST NOT mark seen!
	bgDir := t.TempDir()
	bgStore := newDiskStore(bgDir)

	bgRec := &SessionRecord{
		ID:            "bgsess",
		CWD:           "/tmp",
		Title:         "BG Wake",
		Model:         "m",
		Status:        "idle",
		Options:       SessionOptions{Access: "ask"},
		CreatedAt:     1,
		UpdatedAt:     1,
		TurnSeq:       1,
		AttentionSeq:  1,
		SeenSeq:       0, // Unread from Turn 1!
		AttentionKind: "completed",
	}
	if err := bgStore.saveSessionSync(bgRec); err != nil {
		t.Fatal(err)
	}
	bgHold := make(chan struct{})
	bgAct := newSessionActor("bgsess", bgRec, bgStore, nil, nil, nil)
	bgAct.startWorker = func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		// Append the opening message so transcript + WAL mirror production.
		msg := provider.Message{
			ID:        "bg_u1",
			Role:      provider.RoleUser,
			TurnIndex: snap.turnIndex,
			Content:   []provider.Content{provider.TextBlock{Text: snap.prompt}},
			Meta:      snap.promptMeta,
		}
		env.inbox <- Envelope{Payload: walAppendMsg{gen: snap.gen, ev: walMsgEvent(msg)}, Epoch: snap.epoch}
		<-bgHold
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
	}
	go bgAct.run()
	defer func() { bgAct.control <- shutdownMsg{}; <-bgAct.done }()

	bgAct.inbox <- Envelope{Payload: bgNoticeMsg{JobID: "job_bg1", Text: "[background job_bg1 finished]", Finished: true}}
	waitActorState(t, bgAct, stateRunning)

	// CRITICAL: While the autonomous bg wake turn runs, SeenSeq MUST stay 0 (unread preserved)!
	duringBg := readActorRecord(t, bgAct)
	if duringBg.SeenSeq != 0 || duringBg.AttentionSeq != 1 {
		t.Fatalf("onBgNotice wake must NOT mark session seen: att=%d seen=%d kind=%q",
			duringBg.AttentionSeq, duringBg.SeenSeq, duringBg.AttentionKind)
	}
	fusedBg, _, err := bgStore.loadSessionFused("bgsess")
	if err != nil {
		t.Fatal(err)
	}
	if fusedBg.SeenSeq != 0 || fusedBg.AttentionSeq != 1 {
		t.Fatalf("WAL replay during bg wake lost unread state: att=%d seen=%d", fusedBg.AttentionSeq, fusedBg.SeenSeq)
	}

	close(bgHold)
	waitActorState(t, bgAct, stateIdle)

	afterBg := readActorRecord(t, bgAct)
	if afterBg.AttentionSeq != 2 || afterBg.SeenSeq != 0 || afterBg.AttentionKind != "completed" {
		t.Fatalf("after bg wake turn finishes: want att=2 seen=0 kind=completed, got att=%d seen=%d kind=%q",
			afterBg.AttentionSeq, afterBg.SeenSeq, afterBg.AttentionKind)
	}
}

func TestAttentionUserInteractionsForkAndBootRecovery(t *testing.T) {
	// 1. Explicit user interactions (queue_add, /help, /compact, discard_and_resend, onFork)
	rec := &SessionRecord{
		ID:            "ux1",
		CWD:           t.TempDir(),
		Title:         "UX",
		Model:         "m",
		Status:        "idle",
		Options:       SessionOptions{Access: "ask"},
		CreatedAt:     1,
		UpdatedAt:     1,
		TurnSeq:       1,
		AttentionSeq:  2,
		SeenSeq:       0,
		AttentionKind: "completed",
		Messages: []provider.Message{
			{ID: "u1", Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "first"}}},
			{ID: "a1", Role: provider.RoleAssistant, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "reply"}}},
		},
	}
	act, store, _, stop := newTestActor(t, rec, func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
	})
	defer stop()
	if err := store.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}

	// Forking an unread session resets watermarks to 0, 0, "" on the fork while leaving source untouched.
	fch := make(chan any, 1)
	act.inbox <- Envelope{Payload: forkReqMsg{Keep: 1, Title: "Forked", Reply: fch}}
	fres := (<-fch).(forkResult)
	if fres.Error != "" {
		t.Fatalf("onFork failed: %s", fres.Error)
	}
	forkRec, err := store.loadSession(fres.NewID)
	if err != nil {
		t.Fatal(err)
	}
	if forkRec.AttentionSeq != 0 || forkRec.SeenSeq != 0 || forkRec.AttentionKind != "" {
		t.Fatalf("fork must reset attention watermarks to zero: att=%d seen=%d kind=%q",
			forkRec.AttentionSeq, forkRec.SeenSeq, forkRec.AttentionKind)
	}

	// /compact (even with <4 messages) is an explicit user action -> marks seen!
	act.inbox <- Envelope{Payload: compactNowMsg{}}
	got := readActorRecord(t, act)
	if got.SeenSeq != 2 || got.AttentionKind != "" {
		t.Fatalf("/compact must mark seen: att=%d seen=%d kind=%q", got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}

	// Simulate another unread state, then test /help (onSlashReply) -> marks seen!
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.rec.AttentionSeq = 3
		act.rec.AttentionKind = "error"
	}}}
	ack := make(chan any, 1)
	act.inbox <- Envelope{Payload: slashReplyMsg{Command: "/help", Reply: "help text", Ack: ack}}
	<-ack
	got = readActorRecord(t, act)
	if got.SeenSeq != 3 || got.AttentionKind != "" {
		t.Fatalf("/help must mark seen: att=%d seen=%d kind=%q", got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}

	// Simulate unread state, then test queue_add -> marks seen!
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.rec.AttentionSeq = 4
		act.rec.AttentionKind = "completed"
	}}}
	qch := make(chan any, 1)
	act.inbox <- Envelope{Payload: queueOpMsg{Op: "add", Text: "queued msg", Reply: qch}}
	if qres := (<-qch).(queueOpResult); qres.Error != "" {
		t.Fatal(qres.Error)
	}
	got = readActorRecord(t, act)
	if got.SeenSeq != 4 || got.AttentionKind != "" {
		t.Fatalf("queue_add must mark seen: att=%d seen=%d kind=%q", got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}

	// Simulate unread state, then test discard_and_resend -> marks seen=5 before turn runs, then turn completion bumps att=6!
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.rec.Queue = nil
		act.rec.AttentionSeq = 5
		act.rec.AttentionKind = "error"
	}}}
	dch := make(chan any, 1)
	act.inbox <- Envelope{Payload: discardAndResendMsg{TurnID: 1, Text: "resent", Reply: dch}}
	dres := (<-dch).(discardResendResult)
	if dres.Error != "" {
		t.Fatalf("discard_and_resend failed: %s", dres.Error)
	}
	waitActorState(t, act, stateIdle)
	got = readActorRecord(t, act)
	if got.SeenSeq != 5 || got.AttentionSeq != 6 || got.AttentionKind != "completed" {
		t.Fatalf("discard_and_resend + completion mismatch: att=%d seen=%d kind=%q", got.AttentionSeq, got.SeenSeq, got.AttentionKind)
	}

	// 2. Boot / Crash recovery:
	// - stale "running" without WAL -> idle + AttentionSeq=1, AttentionKind="cancelled"
	// - session with WAL -> WAL preserved on disk AND mirrorSummaries exposes post-WAL attention before route()!
	sup, bootStore, _ := testSupervisor(t)
	writeV1Session(t, sup.dataDir, "stale_boot", "running", 1, 1)

	writeV1Session(t, sup.dataDir, "wal_boot", "idle", 1, 1)
	ww, err := bootStore.openWAL("wal_boot", &walHeader{TurnIndex: 2, StartedAt: 500, Model: "m", Prompt: "in flight"})
	if err != nil {
		t.Fatal(err)
	}
	attSeq, seenSeq, attKind := int64(2), int64(1), "approval"
	if err := appendWALEvent(ww, walEvent{
		Type: walTypeMeta, AttentionSeq: &attSeq, SeenSeq: &seenSeq, AttentionKind: &attKind,
	}); err != nil {
		t.Fatal(err)
	}
	_ = ww.close()

	if err := sup.boot(); err != nil {
		t.Fatal(err)
	}

	staleMeta, err := bootStore.readMetaTail("stale_boot")
	if err != nil {
		t.Fatal(err)
	}
	if staleMeta.Status != "idle" || staleMeta.AttentionSeq != 1 || staleMeta.SeenSeq != 0 || staleMeta.AttentionKind != "cancelled" {
		t.Fatalf("boot stale running recovery mismatch: status=%q att=%d seen=%d kind=%q",
			staleMeta.Status, staleMeta.AttentionSeq, staleMeta.SeenSeq, staleMeta.AttentionKind)
	}

	// WAL file must remain untouched before route(), while mirrorSummaries projects post-WAL state!
	if _, err := os.Stat(bootStore.walPath("wal_boot")); err != nil {
		t.Fatalf("boot removed WAL file: %v", err)
	}
	items, err := sup.mirrorSummaries()
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]map[string]any{}
	for _, it := range items {
		id, _ := it["id"].(string)
		byID[id] = it
	}
	staleItem := byID["stale_boot"]
	if staleItem["status"] != "idle" || staleItem["attentionSeq"] != int64(1) || staleItem["attentionKind"] != "cancelled" {
		t.Fatalf("mirrorSummaries stale_boot mismatch: %+v", staleItem)
	}
	walItem := byID["wal_boot"]
	if walItem["status"] != "running" || walItem["attentionSeq"] != int64(2) || walItem["seenSeq"] != int64(1) || walItem["attentionKind"] != "approval" {
		t.Fatalf("mirrorSummaries wal_boot post-WAL overlay mismatch: %+v", walItem)
	}
}
