package main

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"indirect/indirect-code-daemon/packages/skills"
)

// skillStore is the daemon's per-installation skill registry: *.js skill
// definitions in <data-dir>/skills. Each daemon (each machine) owns its own
// skill files — custom skills are individual per installation. The store is
// read-mostly: reload() re-scans the directory, readers get snapshots.
type skillStore struct {
	mu   sync.RWMutex
	dir  string
	list map[string]skills.Skill
	errs []error
}

// skillRegistryPtr is the process-wide store. Initialized at boot from the
// data dir; tests replace it. Before initialization it serves empty (never
// nil derefs).
//
// The pointer is atomic, not a plain package variable: request goroutines read
// the registry from the dispatch lane (sessionPayload -> skillsApprovalMode)
// while boot and tests swap it, which the race detector flags as an
// unsynchronized read. The store's own contents are guarded by its mutex.
var skillRegistryPtr atomic.Pointer[skillStore]

func init() { skillRegistryPtr.Store(&skillStore{}) }

// skillRegistry returns the current store.
func skillRegistry() *skillStore { return skillRegistryPtr.Load() }

// swapSkillRegistry installs next and returns the store it replaced (tests use
// it to restore the previous registry).
func swapSkillRegistry(next *skillStore) *skillStore { return skillRegistryPtr.Swap(next) }

// skillsDir returns the skill directory under a data dir root.
func skillsDir(dataDir string) string {
	return filepath.Join(dataDir, "skills")
}

// initFrom points the registry at <dataDir>/skills and loads it.
func (s *skillStore) initFrom(dataDir string) {
	s.mu.Lock()
	s.dir = skillsDir(dataDir)
	s.mu.Unlock()
	s.reload()
}

// reload re-scans the skill directory and rebuilds the merged view:
// embedded builtin skills first, then the disk's *.js for every name a
// builtin does not already take. Disk skills may import builtin modules by
// stem. Builtin names are RESERVED — a user
// skill with the same name as a builtin is ignored (builtins cannot be
// overridden from the skills directory) and reported as a load error.
// Parse errors are kept for listing (a hand-edited broken file must not
// crash the daemon) and returned to the caller for logging.
func (s *skillStore) reload() []error {
	s.mu.RLock()
	dir := s.dir
	s.mu.RUnlock()
	builtins, errs := builtinSkills()
	merged := make(map[string]skills.Skill, len(builtins))
	for k, v := range builtins {
		merged[k] = v
	}
	if dir != "" {
		list, loadErrs := skills.LoadWithModules(dir, builtinSkillSources())
		errs = append(errs, loadErrs...)
		for k, v := range list {
			if _, isBuiltin := builtins[k]; isBuiltin {
				// Builtin wins: same-name user skill is ignored.
				errs = append(errs, fmt.Errorf("skill %s: name %q is reserved by a builtin skill; the user skill is ignored", filepath.Base(v.Path), k))
				continue
			}
			merged[k] = v
		}
	}
	s.mu.Lock()
	s.list = merged
	s.errs = errs
	s.mu.Unlock()
	return errs
}

// get returns one skill by name.
func (s *skillStore) get(name string) (skills.Skill, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sk, ok := s.list[name]
	return sk, ok
}

// all returns a copy of the whole store.
func (s *skillStore) all() map[string]skills.Skill {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]skills.Skill, len(s.list))
	for k, v := range s.list {
		out[k] = v
	}
	return out
}

// errors returns the last load errors (for WS listing).
func (s *skillStore) loadErrors() []error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]error, len(s.errs))
	copy(out, s.errs)
	return out
}

// skillBodies returns the bodies of the named skills in order, skipping
// names missing from the store (deleted files never break a session).
func (s *skillStore) bodies(names []string) []skills.Skill {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]skills.Skill, 0, len(names))
	for _, n := range names {
		if sk, ok := s.list[n]; ok {
			out = append(out, sk)
		}
	}
	return out
}

// resolveSession computes the effective policy for one session's skill
// map under the session's own mode (rec.Options.Mode — received from the
// frontend on create/configure, canonicalized at ingestion). The daemon
// never derives the mode from the skill selection.
func (s *skillStore) resolveSession(active map[string]skills.SessionSkill, mode string) (skills.Effective, error) {
	s.mu.RLock()
	store := s.list
	s.mu.RUnlock()
	return skills.Resolve(store, active, mode)
}

// normalizeSessionSkills relaxes one set of session skill entries into a
// persisted copy. Ingestion is PASSIVE — the frontend owns validation:
// unknown names drop silently (a deleted skill never breaks a session), a
// missing active means false, a missing usable means no session override
// (stored "", resolving to the skill file's original at resolve time), a
// present usable is stored VERBATIM (never validated or second-guessed
// here), and daemon-owned markers (once/inContext/byAI) are never
// accepted from the wire. Base-only skills (file original usable "never")
// cannot be direct selections and drop.
func (s *skillStore) normalizeSessionSkills(in map[string]skills.SessionSkill) map[string]skills.SessionSkill {
	store := s.all()
	out := make(map[string]skills.SessionSkill, len(in))
	for name, st := range in {
		sk, ok := store[name]
		if !ok {
			continue // deleted skill never breaks a session
		}
		if usable, err := skills.UsableValue(sk, ""); err == nil && usable == "never" {
			continue // base-only: invisible to the AI AND to the user
		}
		out[name] = skills.SessionSkill{Priority: st.Priority, Active: st.Active, Usable: st.Usable}
	}
	return out
}

// cloneSkillsMap deep-copies a session skill map (WAL replace events copy).
func cloneSkillsMap(in map[string]skills.SessionSkill) map[string]skills.SessionSkill {
	if in == nil {
		return nil
	}
	out := make(map[string]skills.SessionSkill, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// skillsDescription renders the model-facing skill listing for the
// use_skill tool description: one line per skill the AI may activate
// (effective usable ask/yolo only). The system prompt never lists skills —
// the tool description is the single source. Bodies ride the ephemeral
// <skill> prefix of the turns where they are active.
func (s *skillStore) skillsDescription(mode string, active map[string]skills.SessionSkill) string {
	store := s.all()

	type entry struct{ display, description string }
	var entries []entry
	names := make([]string, 0, len(store))
	for name := range store {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		sk := store[name]
		if sk.Mode != "" && mode != "" && sk.Mode != mode {
			continue
		}
		usable, err := skills.UsableValue(sk, active[name].Usable)
		if err != nil || usable == "deny" || usable == "never" {
			continue // AI cannot activate it directly
		}
		entries = append(entries, entry{name, sk.Description})
	}
	if len(entries) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("Skills available (name exactly as listed):\n")
	for _, e := range entries {
		fmt.Fprintf(&b, "- %s: %s\n", e.display, e.description)
	}
	return b.String()
}

// skillsListing renders the whole skill store for the config pull (the
// frontend's skill manager and session-creation picker). Shape matches the
// web SkillConfig mirror: name -> {name, description, enabled, usable,
// mode, approvalMode}.
// Parse errors go to the daemon log, never to the client payload.
func skillsListing() map[string]any {
	list := skillRegistry().all()
	out := make(map[string]any, len(list))
	for name, sk := range list {
		// The official list carries the file ORIGINAL: no usable key (or a
		// legacy direct value) resolves through UsableValue, whose missing
		// key fallback is deny.
		usable, err := skills.UsableValue(sk, "")
		if err != nil {
			trace("skills.load.error", map[string]any{"err": err.Error()})
			continue
		}
		if usable == "never" {
			continue // base-only: the user must never see it
		}
		out[name] = map[string]any{
			"name":        sk.Name,
			"description": sk.Description,
			"enabled":     true,
			"usable":      usable,
			"mode":        sk.Mode,
			// The frontend derives mode + selector visibility from the
			// primary skill, so the official list must carry approvalMode.
			"approvalMode": sk.ApprovalMode,
		}
	}
	for _, e := range skillRegistry().loadErrors() {
		trace("skills.load.error", map[string]any{"err": e.Error()})
	}
	return out
}
