package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Exact-duplicate background guard: reissuing the identical bash or
// python-code command while an identical job is still running spawns
// a duplicate computation whose output the model usually never
// reads (it reads the first job, or none). The guard refuses the
// duplicate BEFORE execution and points at the running job instead.
// Matching is deliberately EXACT (kind + trimmed label bytes, no
// fuzzy similarity): near-identical commands still run, and a
// command is never deduped against a FINISHED job, so re-validating
// after edits always works. An edit/write since the running job
// started also invalidates the dedupe (its result may be stale).

// bgFingerprint keys a background job by the exact command that
// produced it. Only surrounding whitespace is normalized; every
// internal byte is significant.
func bgFingerprint(kind, label string) string {
	sum := sha256.Sum256([]byte(kind + "\x00" + strings.TrimSpace(label)))
	return hex.EncodeToString(sum[:])
}

// bgCallLabel derives the background-job kind+label a tool call will
// register under, mirroring the label the tools pass to the slow
// hook: bash uses the raw command, python code mode uses the trimmed
// code. ok=false when dedupe must not apply: other tools, python
// script mode (file content can change under the same invocation),
// and python code whose env/stdin/work_dir alter execution without
// touching the label.
func bgCallLabel(call provider.ToolCallBlock) (kind, label string, ok bool) {
	switch call.Name {
	case "bash":
		var a struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(call.Arguments, &a) != nil || strings.TrimSpace(a.Command) == "" {
			return "", "", false
		}
		return "bash", a.Command, true
	case "python":
		var a struct {
			Code    string            `json:"code"`
			Script  string            `json:"script"`
			Stdin   string            `json:"stdin"`
			Workdir string            `json:"work_dir"`
			Env     map[string]string `json:"env"`
		}
		if json.Unmarshal(call.Arguments, &a) != nil {
			return "", "", false
		}
		if strings.TrimSpace(a.Script) != "" || a.Stdin != "" || strings.TrimSpace(a.Workdir) != "" || len(a.Env) > 0 {
			return "", "", false
		}
		code := strings.TrimSpace(a.Code)
		if code == "" {
			return "", "", false
		}
		return "python", code, true
	}
	return "", "", false
}

// bgDedupeStale reports whether file mutations invalidate deduping
// against a running job. mark is the bridge mutation counter when
// the job registered this turn; for jobs from earlier turns (mark
// unknown) any mutation this turn may have landed after the job
// started, so only a mutation-free turn may dedupe against them.
func bgDedupeStale(known bool, mark, current int) bool {
	if known {
		return mark != current
	}
	return current > 0
}

// duplicateBgRefusal returns the refusal reason when this call is an
// exact duplicate of a background job still running for the session,
// or "" to let the call proceed. Supervisor lookups fail open: a
// timeout or shutdown never blocks legitimate work.
func (w *turnBridge) duplicateBgRefusal(call provider.ToolCallBlock) string {
	if w.env.bg == nil {
		return ""
	}
	kind, label, ok := bgCallLabel(call)
	if !ok {
		return ""
	}
	reply := make(chan any, 1)
	select {
	case w.env.bg.inbox <- Envelope{Payload: bgFindRunningMsg{SessionID: w.env.actorID, Fingerprint: bgFingerprint(kind, label), Reply: reply}}:
	case <-w.ctx.Done():
		return ""
	}
	var res bgFindRunningResult
	select {
	case r := <-reply:
		res, _ = r.(bgFindRunningResult)
	case <-w.ctx.Done():
		return ""
	case <-time.After(replyTimeout):
		return ""
	}
	if !res.Found {
		return ""
	}
	mark, known := w.jobMutationMark[res.JobID]
	if bgDedupeStale(known, mark, w.mutationSeq) {
		return ""
	}
	started := time.UnixMilli(res.StartedAt)
	elapsed := time.Since(started).Round(time.Second)
	if elapsed < 0 {
		elapsed = 0
	}
	return fmt.Sprintf("Identical command is already running in the background as job %q (started %s, elapsed %s). This duplicate was NOT executed. Read its output with bg_check (job_id %q) or wait for it with bg_await — do not re-run the same command. If files changed through the shell since it started and you genuinely need a fresh run, bg_cancel that job first, then call again.",
		res.JobID, started.Format("2006-01-02 15:04:05"), elapsed, res.JobID)
}
