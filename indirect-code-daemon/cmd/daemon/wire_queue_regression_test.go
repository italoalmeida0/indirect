package main

// Regression tests for the wire/queue fixes from the indirect-code audit:
//
//	BUG 19: `queue_add` dropped the `yolo` flag on the wire, so a queued
//	        "full access" item lost its access grant at promote time.
//	BUG 33: `queue_update` `attachmentIds` contract, daemon half:
//	        omitted/null = NO CHANGE to the item's attachments, [] clears
//	        them, [ids] replaces them (full-item update: text travels
//	        with the list). The web must send the field omitted for "the
//	        user did not touch the attachments".
//	BUG 42: `queue_send_now` on an idle session lost the send-now intent
//	        when startTurn failed (transient persist error): the item was
//	        demoted to plain queue order.
//	BUG 49: the dashboard `bg_cancel` cancelled any session's job with no
//	        ownership check; a foreign (or session-less) frame must be
//	        refused like the model path (bgSupervisor.cancelJob) already is.

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// BUG 19: the queue_add wire decode must carry `yolo` into the queued item.
func TestQueueAddWireCarriesYOLO(t *testing.T) {
	h := newWSHarness(t)
	h.mkSession(t, "s1")
	h.send(map[string]any{"type": "queue_add", "sessionId": "s1", "text": "hello", "model": "m", "yolo": true})
	q := h.lastType("session_queue")
	if q == nil {
		t.Fatal("no session_queue")
	}
	items, _ := q["queue"].([]any)
	if len(items) != 1 {
		t.Fatalf("want 1 queued item, got %+v", q["queue"])
	}
	item, _ := items[0].(map[string]any)
	if yolo, _ := item["yolo"].(bool); !yolo {
		t.Fatalf("queue_add dropped the yolo flag on the wire: %+v", item)
	}
}

// BUG 33 (daemon half): lock the queue_update attachmentIds contract.
func TestQueueUpdateAttachmentIdsContract(t *testing.T) {
	h := newWSHarness(t)
	attPath := filepath.Join(h.dir, "att.txt")
	if err := os.WriteFile(attPath, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	st := newDiskStore(h.dir)
	rec := &SessionRecord{ID: "s1", CWD: "/tmp", Title: "t", Model: "m", Status: "idle", CreatedAt: 1, UpdatedAt: 1,
		Attachments: []AttachmentRef{{ID: "att", Name: "att.txt", Mime: "text/plain", Size: 5, Path: attPath}}}
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	h.send(map[string]any{"type": "queue_add", "sessionId": "s1", "text": "original", "attachmentIds": []string{"att"}})
	qid, _ := wireWaitQueueHead(t, h, "original")["id"].(string)
	if qid == "" {
		t.Fatal("no queued item id")
	}

	// Omitted attachmentIds: text-only edit, attachments untouched.
	h.send(map[string]any{"type": "queue_update", "sessionId": "s1", "queueId": qid, "text": "textonly"})
	wireRequireItemIDs(t, wireWaitQueueHead(t, h, "textonly"), "att")

	// attachmentIds: null is the same as omitted: no change.
	h.send(map[string]any{"type": "queue_update", "sessionId": "s1", "queueId": qid, "text": "nullcase", "attachmentIds": nil})
	wireRequireItemIDs(t, wireWaitQueueHead(t, h, "nullcase"), "att")

	// attachmentIds: [] clears (full-item update: the text travels along).
	h.send(map[string]any{"type": "queue_update", "sessionId": "s1", "queueId": qid, "text": "cleared", "attachmentIds": []string{}})
	wireRequireItemIDs(t, wireWaitQueueHead(t, h, "cleared"))

	// attachmentIds: [ids] replaces.
	h.send(map[string]any{"type": "queue_update", "sessionId": "s1", "queueId": qid, "text": "replaced", "attachmentIds": []string{"att"}})
	wireRequireItemIDs(t, wireWaitQueueHead(t, h, "replaced"), "att")
}

// BUG 42: a failed turn start in the idle branch must KEEP the send-now
// intent — a transient persist error must not demote the item to plain
// queue order.
func TestQueueSendNowKeepsIntentOnStartFailure(t *testing.T) {
	a := queueTestActor(t)
	res := queueOp(t, a, queueOpMsg{Op: "add", Text: "send me now"})
	if res.Error != "" {
		t.Fatal(res.Error)
	}
	id := res.Items[0].ID
	a.persistErr = errors.New("disk unavailable")
	a.onQueueSendNow(queueSendNowMsg{QueueID: id})
	if !a.sendNow {
		t.Fatal("onQueueSendNow dropped the send-now intent when startTurn failed")
	}
	if len(a.rec.Queue) != 1 || a.rec.Queue[0].ID != id {
		t.Fatalf("the failed item must fall back into the queue, got %+v", a.rec.Queue)
	}
}

// BUG 49: the dashboard bg_cancel must refuse a job owned by another
// session (and frames that name no session at all).
func TestBGCancelRefusesForeignAndUnnamedJobs(t *testing.T) {
	h := newWSHarness(t)
	regA := bgRegister(t, h.bg, "sA", "job a")
	regB := bgRegister(t, h.bg, "sB", "job b")

	// Session sA's frame must not cancel sB's job.
	h.send(map[string]any{"type": "bg_cancel", "jobId": regB.JobID, "sessionId": "sA", "requestId": "r1"})
	if wireWaitError(t, h, "no background task") == nil {
		t.Fatal("foreign bg_cancel was not refused")
	}
	if q := bgQuery(t, h.bg, regB.JobID); q.Status != BgStatusRunning {
		t.Fatalf("foreign bg_cancel cancelled another session's job: %+v", q)
	}

	// A frame that names no session claims no job.
	h.send(map[string]any{"type": "bg_cancel", "jobId": regA.JobID, "requestId": "r2"})
	if wireWaitError(t, h, "sessionId is required") == nil {
		t.Fatal("session-less bg_cancel was not refused")
	}
	if q := bgQuery(t, h.bg, regA.JobID); q.Status != BgStatusRunning {
		t.Fatalf("session-less bg_cancel cancelled a job: %+v", q)
	}

	// The owner still cancels its own job.
	h.send(map[string]any{"type": "bg_cancel", "jobId": regB.JobID, "sessionId": "sB", "requestId": "r3"})
	deadline := time.Now().Add(3 * time.Second)
	for {
		if q := bgQuery(t, h.bg, regB.JobID); q.Status == BgStatusCancelled {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("owner bg_cancel did not land: %+v", bgQuery(t, h.bg, regB.JobID))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// wireWaitQueueHead polls the session_queue echo until its head carries
// wantText (each queue op emits exactly one echo after it applied), then
// returns that head item.
func wireWaitQueueHead(t *testing.T, h *wsHarness, wantText string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if m := h.lastType("session_queue"); m != nil {
			if items, _ := m["queue"].([]any); len(items) > 0 {
				if item, ok := items[0].(map[string]any); ok && item["text"] == wantText {
					return item
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("queue never reached text %q", wantText)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// wireRequireItemIDs asserts the echoed head item's attachment ids.
func wireRequireItemIDs(t *testing.T, item map[string]any, want ...string) {
	t.Helper()
	ids, _ := item["attachmentIds"].([]string)
	if len(ids) != len(want) {
		t.Fatalf("attachments = %v, want %v (item %+v)", ids, want, item)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("attachments = %v, want %v (item %+v)", ids, want, item)
		}
	}
}

// wireWaitError polls the captured ws events for an error carrying substr.
func wireWaitError(t *testing.T, h *wsHarness, substr string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		h.mu.Lock()
		var found map[string]any
		for i := len(h.sent) - 1; i >= 0; i-- {
			m := h.sent[i]
			if m["type"] != "error" {
				continue
			}
			if msg, _ := m["message"].(string); strings.Contains(msg, substr) {
				found = m
				break
			}
		}
		h.mu.Unlock()
		if found != nil {
			return found
		}
		if time.Now().After(deadline) {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
}
