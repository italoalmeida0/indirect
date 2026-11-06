package main

// Regressions for attachment lifecycle on cut/edit operations and for the
// turn_file_changes balloon emitted at turn finish:
//   - an edit/truncate must inline the attachments the user kept or just
//     uploaded, while discarded turns' attachments stop leaking files;
//   - queued messages hold attachment references outside the transcript, so
//     pruning must treat them as live;
//   - a turn that touched no files must never re-emit the previous turn's
//     balloon as if it were its own.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/filetrack"
	"indirect/indirect-code-daemon/packages/provider"
)

func testAttachment(t *testing.T, dir, id, name, body string) AttachmentRef {
	t.Helper()
	path := filepath.Join(dir, id+".bin")
	textPath := path + ".txt"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(textPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return AttachmentRef{
		ID: id, Name: name, Mime: "text/plain", Size: int64(len(body)),
		Path: path, TextPath: textPath, TextChars: len(body),
	}
}

func attachmentIDsOf(rec *SessionRecord) map[string]bool {
	out := map[string]bool{}
	for _, a := range rec.Attachments {
		out[a.ID] = true
	}
	return out
}

func rowText(row provider.Message) string {
	out := ""
	for _, c := range row.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			out += tb.Text
		}
	}
	return out
}

func TestRegressionTruncateAndRunKeepsEditedAndNewAttachments(t *testing.T) {
	dir := t.TempDir()
	atKeep := testAttachment(t, dir, "at-keep", "keep.txt", "KEEP-ATTACHMENT-BODY")
	fresh := testAttachment(t, dir, "fresh", "fresh.txt", "FRESH-ATTACHMENT-BODY")
	orphan := testAttachment(t, dir, "orphan", "orphan.txt", "ORPHAN-ATTACHMENT-BODY")

	rec := newTestRecord("tr-att")
	rec.Messages = darMsgs(4) // turns 1..2; index 2 is the edited boundary
	rec.Messages[2].Meta = map[string]string{"attachments": `[{"id":"at-keep"}]`}
	rec.Messages[3].Meta = map[string]string{"attachments": `[{"id":"orphan"}]`}
	rec.Attachments = []AttachmentRef{atKeep, fresh, orphan}
	rec.Compaction = &core.CompactionState{PreviousSummary: "old", KeepFrom: 2}
	rec.TurnSeq = 2
	a, _ := darActor(t, rec)

	reply := make(chan any, 1)
	a.onTruncateAndRun(truncateAndRunMsg{
		Keep: 2, Text: "edited",
		AttachmentIDs: []string{"at-keep", "fresh"},
		Reply:         reply,
	})
	r := (<-reply).(truncateRunResult)
	if r.Error != "" {
		t.Fatalf("truncateAndRun failed: %s", r.Error)
	}

	// Both the edited message's attachment and the fresh upload survive the
	// cut; only the discarded turn's attachment is pruned.
	ids := attachmentIDsOf(a.rec)
	if !ids["at-keep"] || !ids["fresh"] {
		t.Fatalf("kept/uploaded attachment refs were pruned: %+v", a.rec.Attachments)
	}
	if ids["orphan"] {
		t.Fatalf("discarded turn's attachment ref survived: %+v", a.rec.Attachments)
	}
	for _, p := range []string{atKeep.Path, atKeep.TextPath, fresh.Path, fresh.TextPath} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("attachment file the new row inlines must survive: %v", err)
		}
	}
	for _, p := range []string{orphan.Path, orphan.TextPath} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("orphan attachment file must be deleted: %s", p)
		}
	}

	// The new user row carries and inlines both attachments.
	row := a.rec.Messages[len(a.rec.Messages)-1]
	text := rowText(row)
	for _, want := range []string{"KEEP-ATTACHMENT-BODY", "FRESH-ATTACHMENT-BODY"} {
		if !strings.Contains(text, want) {
			t.Fatalf("new user row does not inline %q: %q", want, text)
		}
	}
	metaIDs := messageAttachmentIDs(row, a.rec.Attachments)
	if len(metaIDs) != 2 || metaIDs[0] != "at-keep" || metaIDs[1] != "fresh" {
		t.Fatalf("new user row attachment meta = %v", metaIDs)
	}

	// The compaction summary described the cut prefix: it is now stale.
	if a.rec.Compaction != nil {
		t.Fatalf("stale compaction summary survived the truncate: %+v", a.rec.Compaction)
	}
}

func TestPruneOrphanAttachmentsKeepsQueuedAttachments(t *testing.T) {
	dir := t.TempDir()
	queued := testAttachment(t, dir, "queued", "queued.txt", "QUEUED-BODY")
	orphan := testAttachment(t, dir, "orphan", "orphan.txt", "ORPHAN-BODY")
	rec := &SessionRecord{
		Queue:       []QueuedMessage{{ID: "q1", Text: "next", AttachmentIDs: []string{"queued"}}},
		Attachments: []AttachmentRef{queued, orphan},
	}
	pruneOrphanAttachments(rec, nil)

	ids := attachmentIDsOf(rec)
	if !ids["queued"] {
		t.Fatalf("queued message attachment was pruned: %+v", rec.Attachments)
	}
	if ids["orphan"] {
		t.Fatalf("unreferenced attachment survived: %+v", rec.Attachments)
	}
	if _, err := os.Stat(queued.Path); err != nil {
		t.Errorf("queued attachment file must survive: %v", err)
	}
	if _, err := os.Stat(orphan.Path); !os.IsNotExist(err) {
		t.Errorf("orphan attachment file must be deleted: %s", orphan.Path)
	}
}

func turnFileChangesEvents(events []any) []map[string]any {
	var out []map[string]any
	for _, ev := range events {
		m, ok := ev.(map[string]any)
		if !ok || m["type"] != "turn_file_changes" {
			continue
		}
		out = append(out, m)
	}
	return out
}

func TestFinishTurnDoesNotReemitStaleBalloon(t *testing.T) {
	balloon1 := filetrack.TurnChanges{
		TurnIndex: 1,
		Files:     []filetrack.ChangedFile{{Path: "a.txt", Rel: "a.txt", Status: "modified"}},
	}
	rec := newTestRecord("ft-stale")
	rec.Messages = darMsgs(4) // turns 1..2
	rec.TurnSeq = 2
	rec.FileBalloons = []filetrack.TurnChanges{balloon1}
	a, _ := darActor(t, rec)
	var events []any
	a.wsSend = func(ev any) { events = append(events, ev) }

	a.finishTurn(true)

	if got := turnFileChangesEvents(events); len(got) != 0 {
		t.Fatalf("turn 2 touched no files but re-emitted turn 1's balloon: %+v", got)
	}
}

func TestFinishTurnEmitsItsOwnBalloon(t *testing.T) {
	rec := newTestRecord("ft-fresh")
	rec.Messages = darMsgs(4) // turns 1..2
	rec.TurnSeq = 2
	rec.FileBalloons = []filetrack.TurnChanges{{
		TurnIndex: 1,
		Files:     []filetrack.ChangedFile{{Path: "old.txt", Rel: "old.txt", Status: "modified"}},
	}}
	a, _ := darActor(t, rec)
	// The worker reports the balloon for the turn that is finishing.
	a.pendingBalloon = &filetrack.TurnChanges{
		TurnIndex: 2,
		Files:     []filetrack.ChangedFile{{Path: "new.txt", Rel: "new.txt", Status: "added"}},
	}
	var events []any
	a.wsSend = func(ev any) { events = append(events, ev) }

	a.finishTurn(true)

	got := turnFileChangesEvents(events)
	if len(got) != 1 {
		t.Fatalf("want exactly one turn_file_changes event, got %d: %+v", len(got), got)
	}
	balloon, ok := got[0]["balloon"].(map[string]any)
	if !ok {
		t.Fatalf("turn_file_changes missing balloon: %+v", got[0])
	}
	if balloon["turnIndex"] != 2 {
		t.Fatalf("emitted balloon turnIndex = %v, want 2", balloon["turnIndex"])
	}
}
