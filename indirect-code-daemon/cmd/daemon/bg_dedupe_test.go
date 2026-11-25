package main

import (
	"encoding/json"
	"testing"

	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/runner"
)

func TestBgFingerprint(t *testing.T) {
	a := bgFingerprint("bash", "  bun test 2>&1 | tail -4  ")
	b := bgFingerprint("bash", "bun test 2>&1 | tail -4")
	if a != b {
		t.Fatal("surrounding whitespace must not change the fingerprint")
	}
	if bgFingerprint("exec_script", "bun test") == bgFingerprint("bash", "bun test") {
		t.Fatal("kind must be part of the fingerprint")
	}
	if bgFingerprint("bash", "bun test | tail -4") == bgFingerprint("bash", "bun test | tail -5") {
		t.Fatal("different commands must not share a fingerprint (no fuzzy matching)")
	}
	if bgFingerprint("bash", "echo  two  spaces") == bgFingerprint("bash", "echo two spaces") {
		t.Fatal("internal whitespace is significant: exact match only")
	}
}

func TestBgCallLabel(t *testing.T) {
	kind, label, ok := bgCallLabel(provider.ToolCallBlock{Name: "bash", Arguments: json.RawMessage(`{"command":"bun test"}`)})
	if !ok || kind != "bash" || label != "bun test" {
		t.Fatalf("bash label derivation: kind=%q label=%q ok=%v", kind, label, ok)
	}
	kind, label, ok = bgCallLabel(provider.ToolCallBlock{Name: "exec_script", Arguments: json.RawMessage(`{"code":"  console.log(1)  "}`)})
	if !ok || kind != "exec_script" || label != "console.log(1)" {
		t.Fatalf("exec_script code label derivation: kind=%q label=%q ok=%v", kind, label, ok)
	}
	// env/stdin/workdir change execution without touching the label.
	if _, _, ok := bgCallLabel(provider.ToolCallBlock{Name: "exec_script", Arguments: json.RawMessage(`{"code":"console.log(1)","env":{"A":"1"}}`)}); ok {
		t.Fatal("exec_script with env must not dedupe")
	}
	if _, _, ok := bgCallLabel(provider.ToolCallBlock{Name: "read", Arguments: json.RawMessage(`{"path":"x"}`)}); ok {
		t.Fatal("non-shell tools must not dedupe")
	}
}

func TestBgDedupeStale(t *testing.T) {
	// Job started this turn (mark known): stale once mutations moved.
	if bgDedupeStale(true, 2, 2) {
		t.Fatal("same mutation mark must dedupe")
	}
	if !bgDedupeStale(true, 2, 3) {
		t.Fatal("an edit/write since the job started must invalidate dedupe")
	}
	// Job from an earlier turn (mark unknown): only a turn without
	// mutations may dedupe against it.
	if bgDedupeStale(false, 0, 0) {
		t.Fatal("no mutations this turn must dedupe against an older job")
	}
	if !bgDedupeStale(false, 0, 1) {
		t.Fatal("mutations this turn must invalidate dedupe against an older job")
	}
}

func TestFindRunningByFingerprint(t *testing.T) {
	fp := bgFingerprint("bash", "bun test")
	b := &bgSupervisor{jobs: map[string]*bgJob{
		"done":    {ID: "done", SessionID: "s1", Status: BgStatusDone, Fingerprint: fp, StartedAt: 100},
		"other":   {ID: "other", SessionID: "s2", Status: BgStatusRunning, Fingerprint: fp, StartedAt: 50},
		"running": {ID: "running", SessionID: "s1", Status: BgStatusRunning, Fingerprint: fp, StartedAt: 200},
		"diff":    {ID: "diff", SessionID: "s1", Status: BgStatusRunning, Fingerprint: "x", StartedAt: 10},
	}}
	got := b.findRunningByFingerprint("s1", fp)
	if got == nil || got.ID != "running" {
		t.Fatalf("expected the running same-session match, got %+v", got)
	}
	if got := b.findRunningByFingerprint("s1", "nope"); got != nil {
		t.Fatalf("expected no match for a different fingerprint, got %+v", got)
	}
}

func TestAdoptOnePreservesNoDedupe(t *testing.T) {
	b := &bgSupervisor{
		dataDir: t.TempDir(),
		jobs:    map[string]*bgJob{},
	}
	st := &runner.State{
		JobID:     "job_nodedupe",
		SessionID: "s1",
		Kind:      "exec_script",
		Label:     "console.log(1)",
		NoDedupe:  true,
		PID:       999999,
		StartedAt: 1000,
	}
	b.adoptOne(st)
	j := b.jobs["job_nodedupe"]
	if j == nil {
		t.Fatal("expected adopted job")
	}
	j.closeDone()
	if j.Fingerprint != "" {
		t.Fatalf("expected empty fingerprint when NoDedupe is true, got %q", j.Fingerprint)
	}
	if !j.NoDedupe {
		t.Fatal("expected NoDedupe to be preserved on adopted bgJob")
	}
	if got := b.findRunningByFingerprint("s1", bgFingerprint("exec_script", "console.log(1)")); got != nil {
		t.Fatalf("NoDedupe adopted job must not match fingerprint lookup, got %+v", got)
	}
}

func TestBgSummaryLabelPreservesCommandAndDedupesByCommand(t *testing.T) {
	b := newBGSupervisor(t.TempDir())
	reply := make(chan any, 1)
	b.onRegister(bgRegisterMsg{
		Kind:      "bash",
		SessionID: "s1",
		Label:     "Unit test execution",
		Command:   "bun test ./test/indirect-code-ui.test.ts",
		StartedAt: 1000,
		Reply:     reply,
	})
	res, ok := (<-reply).(bgRegisterResult)
	if !ok || res.Error != "" || res.JobID == "" {
		t.Fatalf("unexpected register result: %#v", res)
	}
	j := b.jobs[res.JobID]
	if j == nil {
		t.Fatal("expected registered bgJob")
	}
	if j.Label != "Unit test execution" {
		t.Fatalf("j.Label = %q, want summary", j.Label)
	}
	if j.Command != "bun test ./test/indirect-code-ui.test.ts" {
		t.Fatalf("j.Command = %q, want preserved command", j.Command)
	}
	// A duplicate call with a different summary wording still matches the exact command fingerprint.
	kind, cmd, ok := bgCallLabel(provider.ToolCallBlock{
		Name:      "bash",
		Arguments: json.RawMessage(`{"command":"bun test ./test/indirect-code-ui.test.ts","summary":"Different summary wording"}`),
	})
	if !ok || kind != "bash" || cmd != "bun test ./test/indirect-code-ui.test.ts" {
		t.Fatalf("bgCallLabel = (%q, %q, %v)", kind, cmd, ok)
	}
	if got := b.findRunningByFingerprint("s1", bgFingerprint(kind, cmd)); got == nil || got.ID != res.JobID {
		t.Fatalf("expected duplicate guard match by command regardless of summary, got %+v", got)
	}
	// Payload serialization ships both label (summary) and command preview.
	payloads := bgTaskPayloads([]BgTask{{
		ID:        res.JobID,
		Kind:      "bash",
		Label:     j.Label,
		Command:   j.Command,
		Status:    BgStatusRunning,
		StartedAt: 1000,
	}})
	if len(payloads) != 1 || payloads[0]["label"] != "Unit test execution" || payloads[0]["command"] != "bun test ./test/indirect-code-ui.test.ts" {
		t.Fatalf("unexpected bgTaskPayloads: %#v", payloads)
	}
}

func TestBgSupervisorCancelJobPopulatesLabelSummary(t *testing.T) {
	b := testBG(t)
	reply := make(chan any, 1)
	b.inbox <- Envelope{Payload: bgRegisterMsg{
		Kind:      "bash",
		SessionID: "s1",
		Label:     "Dev server startup",
		Command:   "bun run dev --port 3000",
		StartedAt: 1000,
		Reply:     reply,
	}}
	reg := (<-reply).(bgRegisterResult)
	if reg.Error != "" || reg.JobID == "" {
		t.Fatalf("unexpected register result: %#v", reg)
	}

	out, err := b.cancelJob("s1", reg.JobID)
	if err != nil {
		t.Fatalf("cancelJob failed: %v", err)
	}
	if !out.OK || out.Status != BgStatusCancelled || out.Kind != "bash" || out.Label != "Dev server startup" {
		t.Fatalf("unexpected cancel outcome: %+v", out)
	}

	// Second cancel on already-terminal job still returns the task's summary label.
	again, err := b.cancelJob("s1", reg.JobID)
	if err != nil {
		t.Fatalf("second cancelJob failed: %v", err)
	}
	if again.OK || again.Status != BgStatusCancelled || again.Label != "Dev server startup" {
		t.Fatalf("unexpected terminal cancel outcome: %+v", again)
	}
}
