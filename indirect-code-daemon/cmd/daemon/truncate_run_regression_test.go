package main

import (
	"testing"

	"indirect/indirect-code-daemon/packages/provider"
)

// REGRESSION (audit bug 43): truncateAndRunMsg is atomic — a failed start
// must not lose the edit text (the row is durable first), and the cut + row
// land in ONE commit. The old two-step (editRegenerateMsg + userPromptMsg)
// persisted a destructive truncation and lost the text on a failed 2nd leg.

func textIn(t *testing.T, rec *SessionRecord, want string) bool {
	t.Helper()
	for _, m := range rec.Messages {
		for _, c := range m.Content {
			if tb, ok := c.(provider.TextBlock); ok && tb.Text == want {
				return true
			}
		}
	}
	return false
}

func TestRegressionTruncateAndRunAtomicNoLoss(t *testing.T) {
	rec := newTestRecord("tr1")
	rec.Messages = darMsgs(4) // turns 1..2
	rec.TurnSeq = 2
	a, st := darActor(t, rec)
	_ = st

	reply := make(chan any, 1)
	a.onTruncateAndRun(truncateAndRunMsg{Keep: 2, Text: "MY EDITED TEXT", Reply: reply})
	r := (<-reply).(truncateRunResult)
	if r.Error != "" {
		t.Fatalf("truncateAndRun failed: %s", r.Error)
	}
	// The edit text is durable: the transcript ends with the new user row.
	if !textIn(t, a.rec, "MY EDITED TEXT") {
		t.Fatal("BUG 43: the edit text was lost — no user row carries MY EDITED TEXT")
	}
	// The cut happened: kept 2 rows + the new user row.
	if len(a.rec.Messages) != 3 {
		t.Fatalf("want 3 messages (kept 2 + new row), got %d", len(a.rec.Messages))
	}
	if r.TurnSeq == 0 {
		t.Fatal("no turn sequence reported")
	}
}

// REGRESSION (audit bug 43): a FAILED start keeps the edit text durable —
// the promise the old two-step broke (text lost after a persisted cut).
func TestRegressionTruncateAndRunFailedStartKeepsText(t *testing.T) {
	rec := newTestRecord("tr2")
	rec.Messages = darMsgs(4)
	rec.TurnSeq = 2
	a, st := darActor(t, rec)
	_ = st

	// startSeededTurn fails after the durable commit: closing the actor
	// makes the seeded start refuse while persistEdited (direct store call)
	// still succeeds — exactly the "start failed, text SAFE" contract.
	a.closing = true
	reply := make(chan any, 1)
	a.onTruncateAndRun(truncateAndRunMsg{Keep: 2, Text: "SAFE TEXT", Reply: reply})
	r := (<-reply).(truncateRunResult)
	if r.Error == "" {
		t.Fatal("expected an error from the failed turn start")
	}
	// THE ATOMIC CONTRACT: even when the start fails, the text + cut were
	// committed FIRST — the reply reports the text is saved. The old code
	// lost it here (two-step: truncate persisted, text in the caller's
	// variable only).
	if !textIn(t, a.rec, "SAFE TEXT") {
		t.Fatal("BUG 43: edit text lost on failed start — the atomic promise is broken")
	}
}

// REGRESSION (audit bug 43): the cut is ONE commit with the new row — a
// validation error changes nothing (no half-applied truncation).
func TestRegressionTruncateAndRunValidationLeavesRecordIntact(t *testing.T) {
	rec := newTestRecord("tr3")
	rec.Messages = darMsgs(4)
	rec.TurnSeq = 2
	a, st := darActor(t, rec)
	_ = st

	before := len(a.rec.Messages)
	reply := make(chan any, 1)
	a.onTruncateAndRun(truncateAndRunMsg{Keep: 2, Text: "   ", Reply: reply})
	r := (<-reply).(truncateRunResult)
	if r.Error == "" {
		t.Fatal("expected a validation error for empty text with no attachments")
	}
	if len(a.rec.Messages) != before {
		t.Fatalf("record changed on a rejected operation: %d -> %d msgs", before, len(a.rec.Messages))
	}
}
