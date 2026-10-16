package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/skills"
)

// sessionsAdmin implements create/delete/rename/pin + summaries + purge.
// All disk scans are cheap (meta-tail only, no message hydration).

func listSessionSummaries(dataDir string) []SessionSummary {
	st := newDiskStore(dataDir)
	dir := st.sessionsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []SessionSummary
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") || strings.HasSuffix(e.Name(), ".wal.jsonl") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".jsonl")
		meta, err := st.readMetaTail(id)
		if err != nil || meta.ID == "" || meta.ID != id {
			continue
		}
		out = append(out, summaryFromMeta(meta))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

func summaryFromMeta(meta metaLine) SessionSummary {
	var lastTurnStartedAt int64
	if meta.Turn != nil {
		lastTurnStartedAt = meta.Turn.StartedAt
	}
	return SessionSummary{ID: meta.ID, CWD: resolvePath(meta.CWD), Title: meta.Title,
		Model: meta.Model, Status: meta.Status, Pinned: meta.Pinned,
		CreatedAt: meta.CreatedAt, UpdatedAt: meta.UpdatedAt,
		LastTurnStartedAt: lastTurnStartedAt,
		TodosOpen:         meta.TodosOpen, Options: &meta.Options}
}

func sessionListItem(s SessionSummary) map[string]any {
	return map[string]any{
		"id": s.ID, "cwd": s.CWD, "title": s.Title, "model": s.Model,
		"status": s.Status, "pinned": s.Pinned,
		"createdAt": s.CreatedAt, "updatedAt": s.UpdatedAt,
		"lastTurnStartedAt": s.LastTurnStartedAt,
		"todosOpen":         s.TodosOpen, "options": s.Options,
	}
}

// sessionAdmin bundles the callbacks a WS dispatcher needs: route to the
// session supervisor, purge, bg access, config, emit.
type sessionAdmin struct {
	dataDir string
	route   func(id string, forRead bool) spawnResult
	purge   func(id string) error
	bg      *bgSupervisor
	cfg     *configCell
	emit    func(any)
	onEvent func(string)
}

func (a *sessionAdmin) host() string {
	if a.cfg != nil {
		if cfg := a.cfg.load(); cfg != nil {
			return cfg.HostID
		}
	}
	return ""
}

// sendBounded enqueues a supervisor envelope with a bounded retry: the
// bg loop drains its inbox continuously, so a full inbox resolves quickly,
// but a single timed-out send must never silently skip a state change
// (a dropped drop-notices would let a late notice resurrect a deleted
// session; a dropped cancel would leak a running job).
func (a *sessionAdmin) sendBounded(env Envelope, timeout time.Duration) bool {
	if a.bg == nil {
		return false
	}
	deadline := time.Now().Add(timeout)
	for {
		select {
		case a.bg.inbox <- env:
			return true
		default:
		}
		if time.Now().After(deadline) {
			trace("admin.bg.send.lost", map[string]any{"payload": fmt.Sprintf("%T", env.Payload)})
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// purgeSession stops bg jobs, drops the resident actor, deletes disk state.
func (a *sessionAdmin) purgeSession(id string) error {
	if !validSessionID(id) {
		return fmt.Errorf("invalid session id")
	}
	// Best-effort: cancel running jobs of this session via bg supervisor.
	if a.bg != nil {
		reply := make(chan any, 1)
		a.sendBounded(Envelope{Payload: bgJobsOfMsg{SessionID: id, Reply: reply}}, replyTimeout)
		select {
		case r := <-reply:
			if ids, ok := r.([]string); ok {
				for _, jid := range ids {
					creply := make(chan any, 1)
					a.sendBounded(Envelope{Payload: bgCancelMsg{JobID: jid, Reply: creply}}, replyTimeout)
					select {
					case <-creply:
					case <-time.After(replyTimeout):
					}
				}
			}
		case <-time.After(replyTimeout):
		}
		// V2-003: the deleted session's pending notices die with it —
		// a late delivery must never resurrect the session. This send is
		// retried until the supervisor loop accepts it (or the bound
		// expires and the drop is traced). Belt-and-braces (audit bug 71):
		// if the drop message could not be queued, remove the notice/pid
		// files directly (supervisor.purge does the same via
		// PurgeSessionBookkeeping — a lost message must not leak them).
		if !a.sendBounded(Envelope{Payload: bgDropNoticesMsg{SessionID: id}}, 5*time.Second) {
			a.bg.PurgeSessionBookkeeping(id)
		}
	}
	if a.purge == nil {
		err := fmt.Errorf("session purge unavailable")
		if a.emit != nil {
			a.emit(map[string]any{"type": "error", "hostId": a.host(), "sessionId": id, "message": err.Error()})
		}
		return err
	}
	if err := a.purge(id); err != nil {
		a.emit(map[string]any{"type": "error", "hostId": a.host(), "sessionId": id, "message": err.Error()})
		return err
	}
	a.emit(map[string]any{"type": "session_deleted", "hostId": a.host(), "sessionId": id})
	if a.onEvent != nil {
		a.onEvent("sessions")
	}
	return nil
}

func (a *sessionAdmin) createSession(cwd, title, model string, options SessionOptions, requestID string) {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" || cwd == "~" {
		home, _ := os.UserHomeDir()
		cwd = home
	} else if strings.HasPrefix(cwd, "~/") {
		home, _ := os.UserHomeDir()
		cwd = filepath.Join(home, cwd[2:])
	}
	var err error
	cwd, err = filepath.Abs(cwd)
	if err == nil {
		err = os.MkdirAll(cwd, 0o755)
	}
	var info os.FileInfo
	var statErr error
	if err == nil {
		info, statErr = os.Stat(cwd)
	}
	if err != nil || statErr != nil || !info.IsDir() {
		a.emit(map[string]any{"type": "error", "hostId": a.host(), "requestId": requestID, "message": "Select an existing project folder before starting a conversation"})
		return
	}
	sessID := "sess_" + randomID8() + randomID8()
	title = strings.TrimSpace(title)
	titleSource := "manual"
	if title == "" {
		title = "New conversation"
		titleSource = "pending"
	}
	var lastModel string
	if cfg := a.cfg.load(); cfg != nil && cfg.LastSelection != nil {
		lastModel = cfg.LastSelection.Model
	}
	if model == "" {
		model = lastModel
	}
	now := time.Now().UnixMilli()
	norm := normalizedOptions(options)
	// Creation is passive: the client sends ONLY the active skills,
	// sorted by priority (first = primary), each with a usable override
	// only when it differs from the skill file's original (missing =
	// inherit, stored verbatim — the frontend owns validation);
	// unknown/never names drop silently. The session MODE is the wire's
	// mode as canonicalized by normalizedOptions above (the frontend
	// derives it from the primary skill; invalid falls back to "talk").
	recSkills := map[string]skills.SessionSkill{}
	prio := 1
	for _, choice := range options.Skills {
		name := strings.TrimSpace(choice.Name)
		if name == "" || recSkills[name].Active {
			continue
		}
		sk, ok := skillRegistry.get(name)
		if !ok {
			continue
		}
		if usable, err := skills.UsableValue(sk, ""); err != nil || usable == "never" {
			continue // never: base-only, invisible even to the user
		}
		recSkills[name] = skills.SessionSkill{Priority: prio, Active: true, Usable: choice.Usable}
		prio++
	}
	recSkills = skillRegistry.normalizeSessionSkills(recSkills)
	rec := &SessionRecord{
		Options: norm, ID: sessID, CWD: cwd,
		Title: title, TitleSource: titleSource, Model: model,
		Status: "idle", CreatedAt: now, UpdatedAt: now,
		Skills: recSkills,
	}
	st := newDiskStore(a.dataDir)
	if err := st.saveSessionSync(rec); err != nil {
		a.emit(map[string]any{"type": "error", "hostId": a.host(), "requestId": requestID, "message": "Failed to create session: " + err.Error()})
		return
	}
	a.emit(map[string]any{"type": "session_created", "requestId": requestID, "hostId": a.host(), "session": sessionPayloadPaged(rec, 0)})
	if a.onEvent != nil {
		a.onEvent("sessions")
	}
}
