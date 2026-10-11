package main

// Regression tests for WAL restore/replay defects:
//   - Bug 9: a crash in the commit window (turn line written, WAL not yet
//     deleted) used to DUPLICATE every message on load (WAL replay appended
//     blindly); replay must dedup by message identity.
//   - Bug 10: openWAL's fsync error path closed but did NOT remove the
//     half-created WAL, leaving a zombie "resumable" turn and a "file
//     exists" lockout for the next start.
//   - Bug 12: stale/corrupt WALs were never removed, so every load replayed
//     dead events and the next openWAL failed with "file exists".

import (
	"errors"
	"os"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Helpers bgTestStore/bgTestMsg/bgTestRec come from store_wal_bg_test.go:
// one diskStore on a fresh temp slot dir.

// commitWindowState plants the exact post-crash commit-window state: the
// finished turn line is already on disk and the WAL still holds the same
// message events (commitWAL wrote the line, crashed before os.Remove).
func commitWindowState(t *testing.T, s *diskStore) (*SessionRecord, *walHeader) {
	t.Helper()
	u := bgTestMsg(provider.RoleUser, "u-do-it", 1)
	a := bgTestMsg(provider.RoleAssistant, "a-done", 1)
	u.ID, a.ID = "u1", "a1"
	rec := &SessionRecord{ID: "sess-commit-window", TurnSeq: 1}
	rec.Messages = append(rec.Messages, u, a)
	rec.Turn = &TurnActivity{StartedAt: time.Now().UnixMilli(), Status: "completed"}
	if err := s.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	h := &walHeader{TurnIndex: 1, StartedAt: time.Now().Unix(), Prompt: "do it"}
	wal, err := s.openWAL(rec.ID, h)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range []provider.Message{u, a} {
		if err := appendWALEvent(wal, walMsgEvent(m)); err != nil {
			t.Fatal(err)
		}
	}
	// Crash simulation: flush + close WITHOUT commitWAL's WAL removal.
	if err := wal.close(); err != nil {
		t.Fatal(err)
	}
	return rec, h
}

// Bug 9: loadSessionFused must return the 2 committed messages once, not
// 4 (turn line + the same messages re-appended by WAL replay).
func TestCommitWindowCrashDoesNotDuplicateMessages(t *testing.T) {
	s := bgTestStore(t)
	rec, _ := commitWindowState(t, s)

	got, header, err := s.loadSessionFused(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if header == nil {
		t.Fatal("WAL header must be reported")
	}
	if len(got.Messages) != 2 {
		t.Fatalf("fused messages = %d, want 2 (commit-window duplicates): %v", len(got.Messages), msgTexts(got.Messages))
	}
	if got.Messages[0].ID != "u1" || got.Messages[1].ID != "a1" {
		t.Fatalf("wrong fused messages: %v", msgTexts(got.Messages))
	}
}

// Bug 9: the in-RAM record of a resumed (WAL-replaying) session must not
// grow duplicates either — the same fused shape as the disk load.
func TestCommitWindowCrashResumeRecordNotDuplicated(t *testing.T) {
	s := bgTestStore(t)
	rec, _ := commitWindowState(t, s)

	fused, _, err := s.loadSessionFused(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	*rec = *fused // what a resume folds into the live record
	if len(rec.Messages) != 2 {
		t.Fatalf("resumed record = %d messages, want 2: %v", len(rec.Messages), msgTexts(rec.Messages))
	}
}

// Bug 9: replay must dedup ID-less messages by the same content
// fingerprint rule assembleRecord uses (legacy transcripts).
func TestWALReplayDedupsByIDlessContentFingerprint(t *testing.T) {
	s := bgTestStore(t)
	notice := bgTestMsg(provider.RoleUser, "notice", 1)
	notice.ID = ""
	rec := &SessionRecord{ID: "sess-fp-dedup", TurnSeq: 1}
	rec.Messages = append(rec.Messages, notice)
	if err := s.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	h := &walHeader{TurnIndex: 1, StartedAt: time.Now().Unix()}
	wal, err := s.openWAL(rec.ID, h)
	if err != nil {
		t.Fatal(err)
	}
	if err := appendWALEvent(wal, walMsgEvent(notice)); err != nil {
		t.Fatal(err)
	}
	if err := wal.close(); err != nil {
		t.Fatal(err)
	}
	got, _, err := s.loadSessionFused(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Messages) != 1 {
		t.Fatalf("fused messages = %d, want 1 (fingerprint duplicate): %v", len(got.Messages), msgTexts(got.Messages))
	}
}

// Bug 10: EVERY openWAL error path — including the fsync window — must
// close and REMOVE the half-created WAL. A leftover would be resumed as a
// zombie turn (failed prompt re-running) and block the next openWAL.
func TestOpenWALFailureRemovesHalfCreatedWAL(t *testing.T) {
	s := bgTestStore(t)
	fault := errors.New("injected fsync failure")
	walAppendFault = func() error { return fault }
	defer func() { walAppendFault = nil }()

	h := &walHeader{TurnIndex: 1, StartedAt: time.Now().Unix(), Prompt: "FAILED PROMPT"}
	wal, err := s.openWAL("sess-fs-sync-fail", h)
	if err == nil {
		wal.close()
		t.Fatal("openWAL must fail when the post-fsync check fails")
	}
	if !errors.Is(err, fault) {
		t.Fatalf("err = %v, want %v", err, fault)
	}
	p := s.walPath("sess-fs-sync-fail")
	if _, serr := os.Stat(p); !os.IsNotExist(serr) {
		t.Fatalf("half-created WAL must be removed after the fsync error path; stat err = %v", serr)
	}
	// Post-condition that motivated the bug: no zombie resume candidate and
	// no "file exists" lockout on the next start.
	if hdr, herr := s.readWALHeader("sess-fs-sync-fail"); herr != nil || hdr != nil {
		t.Fatalf("no WAL header must survive: header=%v err=%v", hdr, herr)
	}
	walAppendFault = nil // storage healthy again
	if _, err := s.openWAL("sess-fs-sync-fail", h); err != nil {
		t.Fatalf("next openWAL must succeed after the failed one: %v", err)
	}
}

// Bug 12: a WAL for an already-committed turn (header.TurnIndex <
// rec.TurnSeq) is dead — removeStaleWAL must delete it so reads stop
// replaying dead events ("idle = the JSON alone").
func TestRemoveStaleWALDeletesCommittedTurnWAL(t *testing.T) {
	s := bgTestStore(t)
	rec := bgTestRec("sess-stale-wal")
	if err := s.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	h := &walHeader{TurnIndex: 1, StartedAt: time.Now().Unix(), Prompt: "old prompt"}
	wal, err := s.openWAL(rec.ID, h)
	if err != nil {
		t.Fatal(err)
	}
	if err := appendWALEvent(wal, walMsgEvent(bgTestMsg(provider.RoleAssistant, "dead", 1))); err != nil {
		t.Fatal(err)
	}
	if err := wal.close(); err != nil {
		t.Fatal(err)
	}
	rec.TurnSeq = 2 // turn 1 committed meanwhile

	if !s.removeStaleWAL(rec.ID, rec) {
		t.Fatal("stale WAL (header.TurnIndex < rec.TurnSeq) must be removed")
	}
	if _, err := os.Stat(s.walPath(rec.ID)); !os.IsNotExist(err) {
		t.Fatalf("WAL must be gone; stat err = %v", err)
	}
}

// Bug 12: a corrupt WAL (interior corruption, unopenable for append) is
// dead too — it could never be resumed and would fail every load closed.
func TestRemoveStaleWALDeletesCorruptWAL(t *testing.T) {
	s := bgTestStore(t)
	rec := bgTestRec("sess-corrupt-wal")
	if err := s.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	// Header + corrupt INTERIOR line + a valid line after it: a lone bad
	// last line is a torn tail (repairable — live), this is fail-closed.
	garbage := `{"v":1,"type":"header","header":{"turnIndex":1,"startedAt":1}}` + "\n" +
		`{"v":1,"type":"` + "\n" +
		`{"v":1,"type":"title","title":"after"}` + "\n"
	if err := os.WriteFile(s.walPath(rec.ID), []byte(garbage), 0o600); err != nil {
		t.Fatal(err)
	}
	if !s.removeStaleWAL(rec.ID, rec) {
		t.Fatal("corrupt WAL must be removed")
	}
	if _, err := os.Stat(s.walPath(rec.ID)); !os.IsNotExist(err) {
		t.Fatalf("corrupt WAL must be gone; stat err = %v", err)
	}
}

// Bug 12: a healthy WAL for the current turn is NOT stale — kept for
// resume; and the absence of a WAL is a quiet no-op.
func TestRemoveStaleWALKeepsHealthyCurrentTurnWAL(t *testing.T) {
	s := bgTestStore(t)
	rec := bgTestRec("sess-healthy-wal")
	if err := s.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	if s.removeStaleWAL(rec.ID, rec) {
		t.Fatal("no WAL present: nothing must be reported removed")
	}
	h := &walHeader{TurnIndex: rec.TurnSeq, StartedAt: time.Now().Unix(), Prompt: "live turn"}
	wal, err := s.openWAL(rec.ID, h)
	if err != nil {
		t.Fatal(err)
	}
	if err := appendWALEvent(wal, walMsgEvent(bgTestMsg(provider.RoleUser, "live", rec.TurnSeq))); err != nil {
		t.Fatal(err)
	}
	if err := wal.close(); err != nil {
		t.Fatal(err)
	}
	if s.removeStaleWAL(rec.ID, rec) {
		t.Fatal("healthy current-turn WAL must NOT be removed")
	}
	if _, err := os.Stat(s.walPath(rec.ID)); err != nil {
		t.Fatalf("healthy WAL must survive: %v", err)
	}
}

func msgTexts(msgs []provider.Message) []string {
	out := make([]string, 0, len(msgs))
	for _, m := range msgs {
		if len(m.Content) > 0 {
			if tb, ok := m.Content[0].(provider.TextBlock); ok {
				out = append(out, m.ID+":"+tb.Text)
				continue
			}
		}
		out = append(out, m.ID+":?")
	}
	return out
}
