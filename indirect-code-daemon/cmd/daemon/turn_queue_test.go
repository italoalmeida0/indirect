package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/provider"
)

func waitSentMatch(t *testing.T, h *wsHarness, fromIdx int, pred func(map[string]any) bool) (map[string]any, int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		h.mu.Lock()
		for i := fromIdx; i < len(h.sent); i++ {
			m := h.sent[i]
			if pred(m) {
				h.mu.Unlock()
				return m, i + 1
			}
		}
		h.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for matching WS event from index %d", fromIdx)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// 1. HarnessSettings.MidTurnSend validation & update_config round-trip.
func TestMidTurnSendConfigValidationAndRoundTrip(t *testing.T) {
	for _, valid := range []string{"", "queue", "steer", "interrupt"} {
		cfg := &DaemonConfig{Settings: HarnessSettings{MidTurnSend: valid}}
		if err := validateEditableConfig(cfg); err != nil {
			t.Fatalf("expected %q to pass validateEditableConfig, got %v", valid, err)
		}
	}
	if got := normalizedHarness(HarnessSettings{}).MidTurnSend; got != "queue" {
		t.Fatalf("expected empty MidTurnSend to normalize to \"queue\", got %q", got)
	}
	for _, invalid := range []string{"invalid", "send_now", "QUEUE", "abort"} {
		cfg := &DaemonConfig{Settings: HarnessSettings{MidTurnSend: invalid}}
		if err := validateEditableConfig(cfg); err == nil {
			t.Fatalf("expected invalid MidTurnSend %q to be rejected", invalid)
		}
	}

	h := newWSHarness(t)
	initial := &DaemonConfig{
		HostID:   "h",
		Settings: normalizedHarness(HarnessSettings{}),
	}
	if err := saveDaemonConfig(h.dir, initial); err != nil {
		t.Fatal(err)
	}
	h.cfg.store(initial)

	pullConfig := func(reqID string) (string, string) {
		t.Helper()
		h.mu.Lock()
		cursor := len(h.sent)
		h.mu.Unlock()
		h.send(map[string]any{"type": "pull", "id": reqID, "collection": "config"})
		ev, _ := waitSentMatch(t, h, cursor, func(m map[string]any) bool {
			return m["type"] == "pull-response" && m["collection"] == "config"
		})
		items, _ := ev["items"].([]map[string]any)
		if len(items) != 1 {
			t.Fatalf("expected 1 config item, got %+v", ev)
		}
		rev, _ := items[0]["revision"].(string)
		settings, _ := items[0]["settings"].(HarnessSettings)
		return rev, settings.MidTurnSend
	}

	rev, mode := pullConfig("p0")
	if mode != "queue" {
		t.Fatalf("initial MidTurnSend=%q, want queue", mode)
	}

	for _, target := range []struct {
		send string
		want string
	}{
		{send: "steer", want: "steer"},
		{send: "interrupt", want: "interrupt"},
		{send: "", want: "queue"},
		{send: "queue", want: "queue"},
	} {
		h.mu.Lock()
		cursor := len(h.sent)
		h.mu.Unlock()
		reqID := "upd-" + target.want + "-" + target.send
		h.send(map[string]any{
			"type":             "update_config",
			"requestId":        reqID,
			"expectedRevision": rev,
			"settings":         map[string]any{"mid_turn_send": target.send},
		})
		upd, _ := waitSentMatch(t, h, cursor, func(m map[string]any) bool {
			return m["type"] == "config_updated" && m["requestId"] == reqID
		})
		if ok, _ := upd["success"].(bool); !ok {
			t.Fatalf("update_config(%q) failed: %+v", target.send, upd)
		}
		rev, mode = pullConfig("pull-" + reqID)
		if mode != target.want {
			t.Fatalf("after update_config(%q): got %q, want %q", target.send, mode, target.want)
		}
		diskCfg, err := loadDaemonConfig(h.dir)
		if err != nil {
			t.Fatal(err)
		}
		if diskCfg.Settings.MidTurnSend != target.want {
			t.Fatalf("on-disk MidTurnSend=%q, want %q", diskCfg.Settings.MidTurnSend, target.want)
		}
	}

	// Invalid value must be rejected and leave config untouched.
	h.mu.Lock()
	cursor := len(h.sent)
	h.mu.Unlock()
	h.send(map[string]any{
		"type":             "update_config",
		"requestId":        "upd-bad",
		"expectedRevision": rev,
		"settings":         map[string]any{"mid_turn_send": "bogus"},
	})
	badEv, _ := waitSentMatch(t, h, cursor, func(m map[string]any) bool {
		return (m["type"] == "config_updated" || m["type"] == "error") && m["requestId"] == "upd-bad"
	})
	if ok, _ := badEv["success"].(bool); ok {
		t.Fatalf("expected invalid mid_turn_send to fail, got %+v", badEv)
	}
	_, modeAfterBad := pullConfig("pull-after-bad")
	if modeAfterBad != "queue" {
		t.Fatalf("invalid update mutated MidTurnSend to %q", modeAfterBad)
	}
}

// 2. Actor Invariant #4: priority control lane is drained BEFORE a full 64-item inbox batch.
func TestControlDrainedBeforeQueuedInboxBurst(t *testing.T) {
	rec := newTestRecord("inv4-priority")
	store := newDiskStore(t.TempDir())
	if err := store.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	act := newSessionActor(rec.ID, rec, store, nil, nil, nil)
	act.state = stateRunning
	act.gen = 1
	act.workerDone = make(chan struct{})

	var mu sync.Mutex
	var order []string
	act.cancel = func() {
		mu.Lock()
		order = append(order, "cancel")
		mu.Unlock()
	}

	for i := 0; i < 64; i++ {
		idx := i
		act.inbox <- Envelope{Payload: hookMsg{fn: func() {
			mu.Lock()
			if idx == 0 {
				order = append(order, "inbox-0")
			}
			mu.Unlock()
		}}}
	}
	act.control <- cancelTurnMsg{Reason: "user"}

	go act.run()
	t.Cleanup(func() {
		close(act.workerDone)
		act.control <- shutdownMsg{}
		<-act.done
	})

	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		n := len(order)
		snap := append([]string(nil), order...)
		mu.Unlock()
		if n >= 2 {
			if snap[0] != "cancel" {
				t.Fatalf("INV#4 violated: inbox ran before pending control cancel: %v", snap)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for control + inbox processing: %v", snap)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// 2b. Mid-turn prompt modes ("queue", "steer", "interrupt", host default) + stateCancel acceptance.
func TestPromptMidTurnModesAndStateCancelAcceptance(t *testing.T) {
	unblockCancel := make(chan struct{})
	turnStarted := make(chan int, 8)
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		turnStarted <- snap.gen
		<-ctx.Done()
		if snap.gen == 1 {
			<-unblockCancel
		}
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, cancelled: true}}
	}

	var mu sync.Mutex
	var events []map[string]any
	rec := newTestRecord("midturn-modes")
	store := newDiskStore(t.TempDir())
	if err := store.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	act := newSessionActor(rec.ID, rec, store, func(ev any) {
		if m, ok := ev.(map[string]any); ok {
			mu.Lock()
			events = append(events, m)
			mu.Unlock()
		}
	}, nil, nil)
	act.startWorker = worker
	act.supCfg.store(&DaemonConfig{HostID: "h1", Settings: HarnessSettings{MidTurnSend: "steer"}})
	go act.run()
	defer func() {
		select {
		case <-unblockCancel:
		default:
			close(unblockCancel)
		}
		act.control <- shutdownMsg{}
		<-act.done
	}()

	// Start turn 1.
	r1 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "turn 1", Reply: r1}}
	if pr := (<-r1).(promptResult); !pr.Accepted || pr.Queued {
		t.Fatalf("turn 1 start failed: %+v", pr)
	}
	<-turnStarted

	// Omitted MidTurnDelivery inherits host setting ("steer").
	rSteer := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "default-steer", Reply: rSteer}}
	prSteer := (<-rSteer).(promptResult)
	if !prSteer.Accepted || !prSteer.Queued || prSteer.Delivery != "steer" || prSteer.Interrupting {
		t.Fatalf("expected queued steer from host setting, got %+v", prSteer)
	}

	// Explicit "queue" places item behind "steer".
	rQueue := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "explicit-queue", MidTurnDelivery: "queue", Reply: rQueue}}
	prQueue := (<-rQueue).(promptResult)
	if !prQueue.Accepted || !prQueue.Queued || prQueue.Delivery != "queue" {
		t.Fatalf("expected queued passive delivery, got %+v", prQueue)
	}

	// Explicit "interrupt" replies immediately with Interrupting=true and transitions actor to stateCancel.
	rInt := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "explicit-interrupt", MidTurnDelivery: "interrupt", Reply: rInt}}
	prInt := (<-rInt).(promptResult)
	if !prInt.Accepted || !prInt.Queued || prInt.Delivery != "interrupt" || !prInt.Interrupting {
		t.Fatalf("expected interrupt acceptance, got %+v", prInt)
	}

	repCh := make(chan any, 1)
	act.control <- watchdogPingMsg{Reply: repCh}
	if rep := (<-repCh).(watchdogReport); rep.State != stateCancel {
		t.Fatalf("expected stateCancel while worker 1 unwinds, got %q", rep.State)
	}

	// Prompt arriving DURING stateCancel MUST be accepted (zero "previous turn is still stopping" error!).
	rDuringCancel := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "queued-during-cancel", MidTurnDelivery: "queue", Reply: rDuringCancel}}
	prCancel := (<-rDuringCancel).(promptResult)
	if prCancel.Error != "" || !prCancel.Accepted || !prCancel.Queued || prCancel.Delivery != "queue" {
		t.Fatalf("prompt in stateCancel rejected or malformed: %+v", prCancel)
	}

	// Verify canonical queue order before worker 1 finishes: [interrupt, steer, queue1, queue2].
	checkDone := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		defer close(checkDone)
		if len(act.rec.Queue) != 4 {
			t.Errorf("expected 4 queued items, got %d", len(act.rec.Queue))
			return
		}
		got := []string{
			act.rec.Queue[0].Delivery + ":" + act.rec.Queue[0].Text,
			act.rec.Queue[1].Delivery + ":" + act.rec.Queue[1].Text,
			act.rec.Queue[2].Delivery + ":" + act.rec.Queue[2].Text,
			act.rec.Queue[3].Delivery + ":" + act.rec.Queue[3].Text,
		}
		want := []string{
			"interrupt:explicit-interrupt",
			"steer:default-steer",
			"queue:explicit-queue",
			"queue:queued-during-cancel",
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("queue[%d]=%q, want %q (all=%v)", i, got[i], want[i], got)
			}
		}
	}}}
	<-checkDone

	// Unblock worker 1 cancellation -> finishTurn(false) immediately promotes "explicit-interrupt" into turn 2!
	close(unblockCancel)
	select {
	case g2 := <-turnStarted:
		if g2 != 2 {
			t.Fatalf("expected turn 2 to launch from interrupt item, got gen %d", g2)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("interrupt item did not promote into turn 2 after stateCancel completed")
	}

	mu.Lock()
	for _, ev := range events {
		if ev["type"] == "error" && strings.Contains(ev["message"].(string), "previous turn is still stopping") {
			mu.Unlock()
			t.Fatalf("unexpected stopping error emitted: %+v", ev)
		}
	}
	mu.Unlock()
}

// 3. queue_send_now -> "steer" -> queue_cancel_send (×) restores passive Seq slot ->
// AutoCompact (allowSteer: false) keeps "steer" intact -> BeforeRequest (allowSteer: true) consumes FIFO.
func TestQueueSteerStageUnstageAndDeferredBeforeRequestConsumption(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		started <- struct{}{}
		<-release
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}}
	}

	var mu sync.Mutex
	var queueEvents [][]map[string]any
	rec := newTestRecord("steer-stage-cancel")
	attPath := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(attPath, []byte("ATTACHED_STEER_NOTE"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec.Attachments = []AttachmentRef{{ID: "att1", Name: "note.txt", Mime: "text/plain", Size: 19, Path: attPath}}

	store := newDiskStore(t.TempDir())
	if err := store.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	act := newSessionActor(rec.ID, rec, store, func(ev any) {
		m, ok := ev.(map[string]any)
		if !ok || m["type"] != "session_queue" {
			return
		}
		rawItems, _ := m["queue"].([]any)
		snap := make([]map[string]any, 0, len(rawItems))
		for _, it := range rawItems {
			if im, ok := it.(map[string]any); ok {
				snap = append(snap, im)
			}
		}
		mu.Lock()
		queueEvents = append(queueEvents, snap)
		mu.Unlock()
	}, nil, nil)
	act.startWorker = worker
	go act.run()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
		act.control <- shutdownMsg{}
		<-act.done
	}()

	// Start turn 1.
	rStart := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "initial", Reply: rStart}}
	<-rStart
	<-started

	// Add passive Q1, Q2 (with attachment + options), Q3.
	addItem := func(text string, attIDs []string, opts *SessionOptions) string {
		r := make(chan any, 1)
		act.inbox <- Envelope{Payload: userPromptMsg{
			Text: text, AttachmentIDs: attIDs, Options: opts, MidTurnDelivery: "queue", Reply: r,
		}}
		if pr := (<-r).(promptResult); pr.Error != "" {
			t.Fatalf("queue %s: %s", text, pr.Error)
		}
		var id string
		done := make(chan struct{})
		act.inbox <- Envelope{Payload: hookMsg{fn: func() {
			id = act.rec.Queue[len(act.rec.Queue)-1].ID
			close(done)
		}}}
		<-done
		return id
	}

	q1ID := addItem("Q1", nil, nil)
	q2ID := addItem("Q2", []string{"att1"}, &SessionOptions{Mode: "agentic", Access: "full", Effort: "high"})
	q3ID := addItem("Q3", nil, nil)

	// Stage Q2 via queue_send_now -> order becomes [Q2(steer), Q1(queue), Q3(queue)].
	act.inbox <- Envelope{Payload: queueSendNowMsg{QueueID: q2ID}}
	syncHook := func() {
		done := make(chan struct{})
		act.inbox <- Envelope{Payload: hookMsg{fn: func() { close(done) }}}
		<-done
	}
	syncHook()

	mu.Lock()
	stagedSnap := queueEvents[len(queueEvents)-1]
	mu.Unlock()
	if len(stagedSnap) != 3 || stagedSnap[0]["id"] != q2ID || stagedSnap[0]["delivery"] != "steer" {
		t.Fatalf("expected Q2 staged at head with delivery=steer, got %+v", stagedSnap)
	}
	if _, hasOpts := stagedSnap[0]["options"]; !hasOpts {
		t.Fatalf("expected queuePayload to emit options on Q2, got %+v", stagedSnap[0])
	}

	// Cancel send (×) via queue_cancel_send -> Q2 returns to passive slot #2: [Q1, Q2, Q3]!
	act.inbox <- Envelope{Payload: queueCancelSendMsg{QueueID: q2ID}}
	syncHook()

	mu.Lock()
	unstagedSnap := queueEvents[len(queueEvents)-1]
	mu.Unlock()
	if len(unstagedSnap) != 3 ||
		unstagedSnap[0]["id"] != q1ID || unstagedSnap[0]["delivery"] != "queue" ||
		unstagedSnap[1]["id"] != q2ID || unstagedSnap[1]["delivery"] != "queue" ||
		unstagedSnap[2]["id"] != q3ID || unstagedSnap[2]["delivery"] != "queue" {
		t.Fatalf("queue_cancel_send failed to restore exact passive order [Q1, Q2, Q3]: %+v", unstagedSnap)
	}

	// Re-stage Q3 then Q2 as "steer" -> FIFO steer order must be [Q3, Q2, Q1].
	act.inbox <- Envelope{Payload: queueSendNowMsg{QueueID: q3ID}}
	act.inbox <- Envelope{Payload: queueSendNowMsg{QueueID: q2ID}}
	// Also enqueue a background notice into pendingContext before AutoCompact.
	act.inbox <- Envelope{Payload: bgNoticeMsg{JobID: "bg-1", Text: "BG_DONE_NOTICE", Finished: true}}
	syncHook()

	// AutoCompact refresh (allowSteer: false) flushes bgNoticeMsg ONLY; Q3 and Q2 stay staged in Queue!
	compactRefresh := make(chan any, 1)
	act.inbox <- Envelope{Payload: workerRefreshMsg{gen: 1, allowSteer: false, Reply: compactRefresh}}
	compactRes := (<-compactRefresh).(workerRefreshResult)
	if compactRes.stale || len(compactRes.context) != 1 {
		t.Fatalf("expected AutoCompact refresh to flush 1 bg notice, got %+v", compactRes)
	}

	var queueLenDuringCompact int
	doneCompactCheck := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		queueLenDuringCompact = len(act.rec.Queue)
		close(doneCompactCheck)
	}}}
	<-doneCompactCheck
	if queueLenDuringCompact != 3 {
		t.Fatalf("AutoCompact prematurely consumed steer items: queue len=%d, want 3", queueLenDuringCompact)
	}

	// BeforeRequest refresh (allowSteer: true) consumes BOTH steers [Q3, Q2] in FIFO order, leaving [Q1]!
	reqRefresh := make(chan any, 1)
	act.inbox <- Envelope{Payload: workerRefreshMsg{gen: 1, allowSteer: true, Reply: reqRefresh}}
	reqRes := (<-reqRefresh).(workerRefreshResult)
	if reqRes.stale || len(reqRes.context) != 2 {
		t.Fatalf("expected BeforeRequest refresh to consume 2 steer items, got %+v", reqRes)
	}
	if reqRes.options.Effort != "high" {
		t.Fatalf("expected Q2 Options.Effort=high applied on steer consumption, got %+v", reqRes.options)
	}
	var c0Text, c1Text string
	for _, blk := range reqRes.context[0].Content {
		if tb, ok := blk.(provider.TextBlock); ok {
			c0Text += tb.Text
		}
	}
	for _, blk := range reqRes.context[1].Content {
		if tb, ok := blk.(provider.TextBlock); ok {
			c1Text += tb.Text
		}
	}
	if !strings.Contains(c0Text, "Q3") || reqRes.context[0].Meta["steering"] != "true" {
		t.Fatalf("first consumed steer should be Q3 with steering=true, got text=%q meta=%v", c0Text, reqRes.context[0].Meta)
	}
	if !strings.Contains(c1Text, "Q2") || !strings.Contains(c1Text, "ATTACHED_STEER_NOTE") || reqRes.context[1].Meta["steering"] != "true" {
		t.Fatalf("second consumed steer should be Q2 with normalized attachment, got text=%q meta=%v", c1Text, reqRes.context[1].Meta)
	}

	// Late queue_cancel_send on already-consumed Q2 cleanly no-ops and emits session_queue with [Q1].
	mu.Lock()
	beforeNoopCount := len(queueEvents)
	mu.Unlock()
	act.inbox <- Envelope{Payload: queueCancelSendMsg{QueueID: q2ID}}
	syncHook()
	mu.Lock()
	afterNoopCount := len(queueEvents)
	lastSnap := queueEvents[len(queueEvents)-1]
	mu.Unlock()
	if afterNoopCount <= beforeNoopCount {
		t.Fatal("expected late queue_cancel_send to still emit reconciling session_queue")
	}
	if len(lastSnap) != 1 || lastSnap[0]["id"] != q1ID || lastSnap[0]["delivery"] != "queue" {
		t.Fatalf("expected only passive Q1 left in queue, got %+v", lastSnap)
	}
}

// 4a. Plain user Stop ("user" cancel) demotes "steer"/"interrupt" to "queue" and stops idle without promoting.
func TestPlainUserStopDemotesStagedItemsAndNeverStartsQueuedTurn(t *testing.T) {
	turnStarted := make(chan int, 4)
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		turnStarted <- snap.gen
		<-ctx.Done()
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, cancelled: true}}
	}

	act, _, _, stop := newTestActor(t, newTestRecord("plain-stop-demote"), worker)
	defer stop()

	r1 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "turn 1", Reply: r1}}
	<-r1
	<-turnStarted

	// Stage one "steer" item and two passive "queue" items.
	for _, item := range []struct {
		text string
		del  string
	}{
		{"passive-1", "queue"},
		{"steer-1", "steer"},
		{"passive-2", "queue"},
	} {
		r := make(chan any, 1)
		act.inbox <- Envelope{Payload: userPromptMsg{Text: item.text, MidTurnDelivery: item.del, Reply: r}}
		<-r
	}

	// User clicks Stop (Reason: "user").
	act.control <- cancelTurnMsg{Reason: "user"}

	// Wait for actor to settle in stateIdle.
	deadline := time.Now().Add(3 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		rep := (<-repCh).(watchdogReport)
		if rep.State == stateIdle {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("actor did not return to idle after plain user Stop: state=%s", rep.State)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Ensure NO second turn ever launched!
	select {
	case g := <-turnStarted:
		t.Fatalf("plain user Stop unexpectedly started turn %d!", g)
	case <-time.After(100 * time.Millisecond):
	}

	// Verify all 3 items remain in Queue, all demoted to "queue", in passive Seq order!
	done := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		defer close(done)
		if len(act.rec.Queue) != 3 {
			t.Errorf("expected 3 items preserved after Stop, got %d", len(act.rec.Queue))
			return
		}
		want := []string{"passive-1", "steer-1", "passive-2"}
		for i, w := range want {
			if act.rec.Queue[i].Delivery != "queue" || act.rec.Queue[i].Text != w {
				t.Errorf("queue[%d]=%+v, want passive %q", i, act.rec.Queue[i], w)
			}
		}
	}}}
	<-done
}

// 4b. Interrupt mid-stream (via queue_interrupt_now) aborts active SSE stream, preserves partial
// thinking + text in transcript, immediately promotes the interrupting item, and keeps [Q1, Q2] queued behind it.
func TestInterruptMidStreamPreservesPartialAssistantAndPromotesBehindPassiveQueue(t *testing.T) {
	stream1Ready := make(chan struct{})
	var reqMu sync.Mutex
	reqCount := 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqMu.Lock()
		reqCount++
		callNum := reqCount
		reqMu.Unlock()

		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		write := func(s string) {
			_, _ = w.Write([]byte(s))
			if fl != nil {
				fl.Flush()
			}
		}
		if callNum == 1 {
			write("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":10}}}\n\n")
			write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n")
			write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"deep partial thought\"}}\n\n")
			write("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
			write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
			write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial assistant text before interrupt\"}}\n\n")
			write("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n")
			write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_1\",\"name\":\"bash\"}}\n\n")
			write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"command\\\":\\\"ls\"}}\n\n")
			close(stream1Ready)
			<-r.Context().Done()
			return
		}
		// Turn 2 (the interrupting prompt) + subsequent queued turns complete cleanly.
		write("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":12}}}\n\n")
		write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
		write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"interrupt reply done\"}}\n\n")
		write("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
		write("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\n")
		write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer srv.Close()

	turn2Gate := make(chan struct{})
	turn2Entered := make(chan struct{})
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		if snap.gen == 2 {
			close(turn2Entered)
			<-turn2Gate
		}
		client := provider.NewAnthropic("x", srv.URL)
		ag := core.NewAgent(client, "m", "sys", core.NewRegistry())
		ag.SetMessages(cloneMessages(snap.messages))
		ag.OnMessageAppended = func(m provider.Message) {
			m.TurnIndex = snap.turnIndex
			env.inbox <- Envelope{Epoch: snap.epoch, Payload: walAppendMsg{gen: snap.gen, ev: walMsgEvent(m)}}
		}
		err := ag.Prompt(ctx, snap.prompt, nil, func(core.AgentEvent) {})
		cancelled := ctx.Err() != nil
		errStr := ""
		if err != nil && !cancelled {
			errStr = err.Error()
		}
		env.inbox <- Envelope{Epoch: snap.epoch, Payload: workerFinishedMsg{gen: snap.gen, cancelled: cancelled, err: errStr}}
	}

	rec := newTestRecord("interrupt-partial")
	act, store, _, stop := newTestActor(t, rec, worker)
	defer func() {
		select {
		case <-turn2Gate:
		default:
			close(turn2Gate)
		}
		stop()
	}()

	// Start turn 1 and wait until partial thinking + text + unclosed tool_use are streamed.
	r1 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "turn 1 prompt", Reply: r1}}
	<-r1
	<-stream1Ready
	// Give the client goroutine a moment to consume the flushed SSE chunks before cancel.
	time.Sleep(40 * time.Millisecond)

	// Queue [Q1, Q2, INT_TARGET] passively, then trigger queue_interrupt_now on INT_TARGET!
	enqueue := func(txt string) string {
		r := make(chan any, 1)
		act.inbox <- Envelope{Payload: userPromptMsg{Text: txt, MidTurnDelivery: "queue", Reply: r}}
		<-r
		var id string
		done := make(chan struct{})
		act.inbox <- Envelope{Payload: hookMsg{fn: func() {
			id = act.rec.Queue[len(act.rec.Queue)-1].ID
			close(done)
		}}}
		<-done
		return id
	}
	_ = enqueue("Q1")
	_ = enqueue("Q2")
	intID := enqueue("INTERRUPT_NOW_PROMPT")

	act.inbox <- Envelope{Payload: queueInterruptNowMsg{QueueID: intID}}

	// Turn 2 must launch immediately with "INTERRUPT_NOW_PROMPT" while [Q1, Q2] stay queued behind it!
	select {
	case <-turn2Entered:
	case <-time.After(3 * time.Second):
		t.Fatal("turn 2 did not launch after queue_interrupt_now")
	}

	verifyMidTurn2 := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		defer close(verifyMidTurn2)
		if len(act.rec.Queue) != 2 || act.rec.Queue[0].Text != "Q1" || act.rec.Queue[1].Text != "Q2" {
			t.Errorf("expected passive [Q1, Q2] preserved behind promoted interrupt, got %+v", act.rec.Queue)
		}
		// Verify partial thinking + text from cancelled turn 1 survived in transcript!
		var sawThinking, sawPartialText bool
		for _, m := range act.rec.Messages {
			if m.Role != provider.RoleAssistant {
				continue
			}
			for _, c := range m.Content {
				switch b := c.(type) {
				case provider.ReasoningBlock:
					if strings.Contains(b.Summary, "deep partial thought") {
						sawThinking = true
					}
				case provider.TextBlock:
					if strings.Contains(b.Text, "partial assistant text before interrupt") {
						sawPartialText = true
					}
				}
			}
		}
		if !sawThinking || !sawPartialText {
			t.Errorf("partial assistant blocks lost on interrupt: sawThinking=%v sawPartialText=%v msgs=%+v", sawThinking, sawPartialText, act.rec.Messages)
		}
	}}}
	<-verifyMidTurn2

	// Let turn 2 (and promoted Q1, Q2) finish cleanly and check persisted disk state.
	close(turn2Gate)
	deadline := time.Now().Add(3 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		rep := (<-repCh).(watchdogReport)
		if rep.State == stateIdle {
			var qLen int
			ch := make(chan struct{})
			act.inbox <- Envelope{Payload: hookMsg{fn: func() {
				qLen = len(act.rec.Queue)
				close(ch)
			}}}
			<-ch
			if qLen == 0 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for promoted turns to drain")
		}
		time.Sleep(15 * time.Millisecond)
	}

	diskRec, _, err := store.loadSessionFused(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if diskRec.TurnSeq != 4 {
		t.Fatalf("expected 4 total turns (1 interrupted + 1 interrupt + Q1 + Q2), got TurnSeq=%d", diskRec.TurnSeq)
	}
}

// 5. queue_reorder, queue_clear, idle queue_send_now preserving Options, and boot/WAL crash-recovery normalization.
func TestQueueReorderClearIdleOptionsAndCrashRecoveryNormalization(t *testing.T) {
	h := newWSHarness(t)
	h.mkSession(t, "s-ops")

	addWS := func(text, delivery string, opts map[string]any) map[string]any {
		h.mu.Lock()
		cursor := len(h.sent)
		h.mu.Unlock()
		cmd := map[string]any{"type": "queue_add", "sessionId": "s-ops", "text": text}
		if delivery != "" {
			cmd["delivery"] = delivery
		}
		if opts != nil {
			cmd["options"] = opts
		}
		h.send(cmd)
		ev, _ := waitSentMatch(t, h, cursor, func(m map[string]any) bool {
			return m["type"] == "session_queue" && m["sessionId"] == "s-ops"
		})
		items, _ := ev["queue"].([]any)
		return items[len(items)-1].(map[string]any)
	}

	q1 := addWS("P1", "queue", nil)
	q2 := addWS("P2", "queue", map[string]any{"mode": "agentic", "effort": "high", "access": "ask", "skills": []any{}})
	q3 := addWS("P3", "queue", nil)
	s1 := addWS("S1", "steer", nil)
	_ = s1

	// Fetch latest queue snapshot to read s1's id (since steer sorted to index 0).
	lastQ := h.lastType("session_queue")["queue"].([]any)
	s1ID := lastQ[0].(map[string]any)["id"].(string)
	q1ID := q1["id"].(string)
	q2ID := q2["id"].(string)
	q3ID := q3["id"].(string)

	// Reorder passive items to [P3, P1, P2] — S1 ("steer") MUST remain ahead at index 0!
	h.mu.Lock()
	cursor := len(h.sent)
	h.mu.Unlock()
	h.send(map[string]any{
		"type":      "queue_reorder",
		"sessionId": "s-ops",
		"queueIds":  []string{q3ID, q1ID, q2ID},
	})
	reorderedEv, _ := waitSentMatch(t, h, cursor, func(m map[string]any) bool {
		return m["type"] == "session_queue" && m["sessionId"] == "s-ops"
	})
	rItems := reorderedEv["queue"].([]any)
	if len(rItems) != 4 ||
		rItems[0].(map[string]any)["id"] != s1ID ||
		rItems[1].(map[string]any)["id"] != q3ID ||
		rItems[2].(map[string]any)["id"] != q1ID ||
		rItems[3].(map[string]any)["id"] != q2ID {
		t.Fatalf("unexpected order after queue_reorder: %+v", rItems)
	}

	// queue_clear removes passive "queue" items while leaving staged S1 untouched!
	h.mu.Lock()
	cursor = len(h.sent)
	h.mu.Unlock()
	h.send(map[string]any{"type": "queue_clear", "sessionId": "s-ops"})
	clearedEv, _ := waitSentMatch(t, h, cursor, func(m map[string]any) bool {
		return m["type"] == "session_queue" && m["sessionId"] == "s-ops"
	})
	cItems := clearedEv["queue"].([]any)
	if len(cItems) != 1 || cItems[0].(map[string]any)["id"] != s1ID {
		t.Fatalf("queue_clear should keep staged S1 and drop passive items, got %+v", cItems)
	}

	// Unstage S1 via queue_cancel_send, then queue_clear removes it completely.
	h.mu.Lock()
	cursor = len(h.sent)
	h.mu.Unlock()
	h.send(map[string]any{"type": "queue_cancel_send", "sessionId": "s-ops", "queueId": s1ID})
	_, _ = waitSentMatch(t, h, cursor, func(m map[string]any) bool {
		return m["type"] == "session_queue" && m["sessionId"] == "s-ops"
	})
	h.mu.Lock()
	cursor = len(h.sent)
	h.mu.Unlock()
	h.send(map[string]any{"type": "queue_clear", "sessionId": "s-ops"})
	emptyEv, _ := waitSentMatch(t, h, cursor, func(m map[string]any) bool {
		return m["type"] == "session_queue" && m["sessionId"] == "s-ops"
	})
	if len(emptyEv["queue"].([]any)) != 0 {
		t.Fatalf("expected empty queue after unstage + queue_clear, got %+v", emptyEv["queue"])
	}

	// Idle queue_send_now preserves Options, Model, YOLO, and AttachmentIDs when starting a turn!
	gotSnap := make(chan workerSnapshot, 1)
	idleRec := newTestRecord("idle-opts")
	idleRec.Options = SessionOptions{Mode: "talk", Effort: "low", Access: "ask"}
	idleRec.Queue = []QueuedMessage{{
		ID:      "q-opts",
		Text:    "run with custom options",
		Model:   "claude-opus-4-6",
		YOLO:    true,
		Options: &SessionOptions{Mode: "agentic", Effort: "high", Access: "ask"},
		Seq:     1,
	}}
	idleAct, _, _, stopIdle := newTestActor(t, idleRec, func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		gotSnap <- snap
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}}
	})
	defer stopIdle()

	idleAct.inbox <- Envelope{Payload: queueSendNowMsg{QueueID: "q-opts"}}
	snap := <-gotSnap
	if snap.model != "claude-opus-4-6" || snap.options.Mode != "agentic" || snap.options.Effort != "high" || snap.options.Access != "full" {
		t.Fatalf("idle queue_send_now dropped item Model/YOLO/Options: model=%q options=%+v", snap.model, snap.options)
	}

	// Boot + WAL Crash-Recovery Normalization:
	// Case A: non-WAL session on disk with stale Status="running" and staged "steer"/"interrupt" items.
	crashDir := t.TempDir()
	crashStore := newDiskStore(crashDir)
	noWalRec := &SessionRecord{
		ID:     "crash-no-wal",
		CWD:    crashDir,
		Title:  "crash1",
		Model:  "m",
		Status: "running",
		Turn:   &TurnActivity{StartedAt: 10, Status: "running"},
		Queue: []QueuedMessage{
			{ID: "i1", Text: "int", Delivery: "interrupt", Seq: 2},
			{ID: "q1", Text: "pas", Delivery: "queue", Seq: 1},
			{ID: "s1", Text: "str", Delivery: "steer", Seq: 3},
		},
	}
	if err := crashStore.saveSessionSync(noWalRec); err != nil {
		t.Fatal(err)
	}

	// Case B: WAL session crashed mid-cancel ("interrupt_and_send" wrote TurnStatus="cancelling" + walTypeQueue).
	walBase := &SessionRecord{
		ID:      "crash-wal-cancel",
		CWD:     crashDir,
		Title:   "crash2",
		Model:   "m",
		Status:  "idle",
		TurnSeq: 1,
	}
	if err := crashStore.saveSessionSync(walBase); err != nil {
		t.Fatal(err)
	}
	ww, err := crashStore.openWAL("crash-wal-cancel", &walHeader{TurnIndex: 1, StartedAt: 20, Prompt: "turn1"})
	if err != nil {
		t.Fatal(err)
	}
	_ = appendWALEvent(ww, walEvent{Type: walTypeQueue, Queue: []QueuedMessage{
		{ID: "wi1", Text: "interrupt-msg", Delivery: "interrupt", Seq: 2},
		{ID: "wq1", Text: "passive-msg", Delivery: "queue", Seq: 1},
	}})
	_ = appendWALEvent(ww, walEvent{Type: walTypeTurnState, TurnStatus: "cancelling"})
	_ = ww.close()

	sup := newSessionSupervisor(crashDir, &configCell{}, nil, nil)
	if err := sup.boot(); err != nil {
		t.Fatal(err)
	}

	// Verify Case A normalized on boot() even before routing!
	bootedA, _, err := crashStore.loadSessionFused("crash-no-wal")
	if err != nil {
		t.Fatal(err)
	}
	if bootedA.Status != "idle" {
		t.Fatalf("expected crash-no-wal Status=idle after boot, got %q", bootedA.Status)
	}
	if len(bootedA.Queue) != 3 ||
		bootedA.Queue[0].ID != "q1" || bootedA.Queue[0].Delivery != "queue" ||
		bootedA.Queue[1].ID != "i1" || bootedA.Queue[1].Delivery != "queue" ||
		bootedA.Queue[2].ID != "s1" || bootedA.Queue[2].Delivery != "queue" {
		t.Fatalf("boot() did not normalize staged queue items to passive Seq order: %+v", bootedA.Queue)
	}

	// Route Case B (routeCold) -> cancelling WAL is discarded, session boots idle with queue intact & normalized!
	resB := sup.route("crash-wal-cancel", true)
	if resB.Error != "" {
		t.Fatalf("routeCold(crash-wal-cancel): %s", resB.Error)
	}
	defer func() {
		resB.Control <- shutdownMsg{}
		<-resB.Done
	}()

	readCh := make(chan any, 1)
	resB.Inbox <- Envelope{Payload: readReqMsg{What: "session", Reply: readCh}}
	rd := (<-readCh).(readResult)
	recB := rd.Payload.(*SessionRecord)
	if recB.Status != "idle" {
		t.Fatalf("expected crash-wal-cancel to recover in idle, got %q", recB.Status)
	}
	if len(recB.Queue) != 2 ||
		recB.Queue[0].ID != "wq1" || recB.Queue[0].Delivery != "queue" ||
		recB.Queue[1].ID != "wi1" || recB.Queue[1].Delivery != "queue" {
		t.Fatalf("routeCold did not preserve & normalize WAL queue items: %+v", recB.Queue)
	}

	// Also verify JSON round-trip of QueuedMessage preserves Delivery, Seq, and Options.
	rawJSON, err := json.Marshal(recB.Queue)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rawJSON), `"delivery":"queue"`) {
		t.Fatalf("expected delivery serialized in QueuedMessage JSON: %s", rawJSON)
	}
}
