package main

import (
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

// Regression (audit bug 1): append dropped a head chunk whose tail was a
// partial line together with its continuation in the retained tail, so the
// tail started mid-line (line-boundary invariant broken) AND DroppedLines
// counted the line as fully dropped when only its head was gone. Whole
// lines only: the partial-line residue stays with the retained content and
// only fully-dropped lines are counted.
func TestBgBufferPartialLineResidueKeepsDroppedLinesHonest(t *testing.T) {
	rec := testBgRec()
	registerBg(rec, "bg_1", "bash", "probe")
	// The 2-line input "l1\nparcialcompleta\n" arrives split mid-line.
	applyBgChunk(rec, "bg_1", "l1\nparcial", 10)
	applyBgChunk(rec, "bg_1", "completa\n", 10)
	task := rec.BgTasks[0]
	if task.DroppedLines != 1 {
		t.Fatalf("DroppedLines=%d, want 1 (only \"l1\" is fully dropped; \"parcial\" continues in the retained tail)", task.DroppedLines)
	}
	if task.Content != "parcialcompleta\n" {
		t.Fatalf("retained tail must keep the partial-line residue at a line boundary: %q", task.Content)
	}
	if task.TotalLines != 2 {
		t.Fatalf("TotalLines=%d, want 2", task.TotalLines)
	}
	// Same counter convention as recovery (restoreRunnerOutput): dropped
	// lines are the total minus the retained ones.
	if got := task.TotalLines - int64(countLines(task.Content)); got != task.DroppedLines {
		t.Fatalf("counter disagreement with retained content: total-retained=%d but DroppedLines=%d", got, task.DroppedLines)
	}
}

// Regression (audit bug 21): bgTaskPayloads cut content by bytes, which
// could split a multibyte rune and ship invalid UTF-8 to the client. The
// cut must realign to a rune boundary.
func TestBgTaskPayloadsByteCutRealignsToRuneBoundary(t *testing.T) {
	// 30KB single line of 3-byte runes: the 20KB cut lands mid-rune.
	huge := strings.Repeat("世", 10*1024)
	payloads := bgTaskPayloads([]BgTask{{
		ID: "bg_1", Kind: "bash", Label: "probe", Status: BgStatusRunning,
		Content: huge, TotalLines: 1, TotalBytes: int64(len(huge)),
	}})
	content, _ := payloads[0]["content"].(string)
	if !utf8.ValidString(content) {
		t.Fatalf("payload content is invalid UTF-8 (byte cut split a rune): tail=%q", content[len(content)-8:])
	}
	if !strings.HasSuffix(huge, content) {
		t.Fatal("payload content must be a suffix of the task content")
	}
}

// Regression (audit bug 23): label[:60] cut bytes and split a multibyte
// rune when rendering the task list. The cut must be rune-aware (like
// noticePreview).
func TestListBgTaskIDsLabelCutIsRuneSafe(t *testing.T) {
	// 59 one-byte chars + 3-byte runes: the 60-byte cut lands mid-rune.
	rec := testBgRec()
	registerBg(rec, "bg_1", "bash", strings.Repeat("a", 59)+"世界")
	out := listBgTaskIDs(rec)
	if !utf8.ValidString(out) {
		t.Fatalf("label byte-cut split a multibyte rune: tail=%q", out[len(out)-8:])
	}
}

// Regression (audit bug 24): loadNotices used to DELETE unparseable
// notice files, losing the completion notice forever. A torn notice.json
// must stay on disk (traced) for inspection/repair.
func TestLoadNoticesKeepsTornNoticeOnDisk(t *testing.T) {
	b := newBGSupervisor(t.TempDir())
	torn := b.noticePath("bg_torn")
	if err := os.MkdirAll(b.bgDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(torn, []byte(`{"jobId":"bg_torn","ses`), 0o600); err != nil {
		t.Fatal(err)
	}
	b.loadNotices()
	if _, err := os.Stat(torn); err != nil {
		t.Fatalf("torn notice.json must stay on disk after loadNotices: %v", err)
	}
	if len(b.notices) != 0 {
		t.Fatalf("torn notice must not load into the map: %+v", b.notices)
	}
}

// Regression (audit bug 20): purging a session leaked its bg/ pid and
// notice files forever (boot could even re-deliver notices for the dead
// session). PurgeSessionBookkeeping removes them and leaves other
// sessions' files alone.
func TestPurgeSessionBookkeepingRemovesPidAndNoticeFiles(t *testing.T) {
	b := newBGSupervisor(t.TempDir())
	write := func(jobID, sessionID string) (string, string) {
		if err := b.writePidfile(&bgJob{
			ID: jobID, SessionID: sessionID, Kind: "bash", Label: "probe",
			PID: 4242, Identity: "id-" + jobID, StartedAt: 1, LogPath: "out.log",
		}); err != nil {
			t.Fatal(err)
		}
		b.retainNotice(jobID, sessionID, "finished", true)
		return b.pidPath(jobID), b.noticePath(jobID)
	}
	deadPID, deadNotice := write("bg_dead", "sess_del")
	keepPID, keepNotice := write("bg_keep", "sess_keep")

	b.PurgeSessionBookkeeping("sess_del")

	for _, p := range []string{deadPID, deadNotice} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("purged session's bookkeeping survived: %s (%v)", p, err)
		}
	}
	for _, p := range []string{keepPID, keepNotice} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("other session's bookkeeping must survive purge: %s (%v)", p, err)
		}
	}
}
