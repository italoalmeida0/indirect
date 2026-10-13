package main

import (
	"encoding/json"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestBgFingerprint(t *testing.T) {
	a := bgFingerprint("bash", "  bun test 2>&1 | tail -4  ")
	b := bgFingerprint("bash", "bun test 2>&1 | tail -4")
	if a != b {
		t.Fatal("surrounding whitespace must not change the fingerprint")
	}
	if bgFingerprint("python", "bun test") == bgFingerprint("bash", "bun test") {
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
	kind, label, ok = bgCallLabel(provider.ToolCallBlock{Name: "python", Arguments: json.RawMessage(`{"code":"  print(1)  "}`)})
	if !ok || kind != "python" || label != "print(1)" {
		t.Fatalf("python code label derivation: kind=%q label=%q ok=%v", kind, label, ok)
	}
	// Script mode: the file content can change under the same
	// invocation, so dedupe never applies.
	if _, _, ok := bgCallLabel(provider.ToolCallBlock{Name: "python", Arguments: json.RawMessage(`{"script":"x.py"}`)}); ok {
		t.Fatal("python script mode must not dedupe")
	}
	// env/stdin/workdir change execution without touching the label.
	if _, _, ok := bgCallLabel(provider.ToolCallBlock{Name: "python", Arguments: json.RawMessage(`{"code":"print(1)","env":{"A":"1"}}`)}); ok {
		t.Fatal("python with env must not dedupe")
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
