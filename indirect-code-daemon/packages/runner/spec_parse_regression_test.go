package runner

import "testing"

// Regression (audit bug 25): SplitN("__", 3) could not round-trip ids
// containing "__" — the fallback identity (filename) became unparseable
// exactly when it mattered most (state file gone). Parse must resolve the
// separators from the ends so a job id with "__" round-trips.
func TestParseOutNameRoundTripsJobWithDunders(t *testing.T) {
	name := OutName("sess1", "job__y", 1760000000000)
	sid, jid, ms, ok := ParseOutName(name)
	if !ok {
		t.Fatalf("ParseOutName(%q) failed", name)
	}
	if sid != "sess1" || jid != "job__y" || ms != 1760000000000 {
		t.Fatalf("round-trip lost identity: %q -> sid=%q jid=%q ms=%d", name, sid, jid, ms)
	}
	// A job id with SEVERAL dunders round-trips too.
	name = OutName("sess1", "job__with__dunders", 1760000000000)
	sid, jid, ms, ok = ParseOutName(name)
	if !ok || sid != "sess1" || jid != "job__with__dunders" || ms != 1760000000000 {
		t.Fatalf("multi-dunder round-trip: %q -> %q %q %d %v", name, sid, jid, ms, ok)
	}
}
