package skills

import (
	"fmt"
	"sort"
)

// SessionSkill is one skill's session state, persisted in the session
// record under `skills` (keyed by skill name).
//
// Wire rules (create/update): the client sends only what CHANGED. A missing
// active key means false; a missing usable key (or explicit "inherit")
// means the session carries no override and the skill file's original
// applies; priority is daemon-assigned (create order / reorder) and never
// accepted as a per-skill edit. once, inContext and byAI are daemon-owned
// markers.
type SessionSkill struct {
	Priority int  `json:"priority,omitempty"`
	Active   bool `json:"active,omitempty"`
	// Usable is the session's OVERRIDE of the skill file's original
	// activation policy. "" and "inherit" both mean no override (the
	// original applies). An explicit value still moves only within the
	// locks of the usability table: deny/never/yolo originals are locked,
	// and an ask original may be pinned to ask, yolo or deny.
	Usable string `json:"usable,omitempty"`
	// Once marks an AI activation with once=true: deactivated at turn end.
	// A user (re)activation of the skill always clears the flag.
	Once bool `json:"once,omitempty"`
	// InContext reports the skill body is already in this turn's context:
	// it rode a use_skill tool_result earlier in the turn. Such skills are
	// excluded from the <skill> prefix (the text appears exactly once per
	// turn). Cleared at turn end — the tool calls are never committed.
	InContext bool `json:"inContext,omitempty"`
	// ByAI records the source of the LAST activation: true when the AI
	// loaded it with use_skill, false when the user activated it in the
	// frontend. A user deactivation of a still-ByAI skill emits the
	// ephemeral system notice (once: the deactivation clears ByAI).
	ByAI bool `json:"byAI,omitempty"`
}

// Effective is the fully resolved per-session skill state. It is a pure
// value: the daemon projects it onto the tool registry and the approval
// gate.
type Effective struct {
	// Mode is the session's base mode ("agentic" or "talk"). It is
	// SUPPLIED by the caller (the frontend derives it from the primary
	// skill and sends it on create/configure; the daemon only validates
	// the enum). It is never derived from skills here.
	Mode string
	// AskAutoApprove is the main skill's approvalMode. It
	// decides how a tool whose policy resolves to "ask" is handled: "ask"
	// (default) shows human approval, "yolo" auto-approves (it bypasses
	// the user's own ask rules). It never changes availability.
	AskAutoApprove bool
	// Chain is the resolution chain, HIGHEST scope first: the active
	// skills in reverse priority order. The first scope with an explicit
	// entry for a tool/arg decides; the universal fallback is deny. Bases
	// are not separate scopes: a skill that imports a base decides which
	// of its values to keep, so what arrives here is the final object.
	Chain []Skill
	// Order lists contributing skill names in prefix order (user
	// selection by priority).
	Order []string
	// Bodies maps skill name -> body text for the ephemeral <skill> prefix.
	Bodies map[string]string
	// Listed is the model-facing skill set: the names the AI may load
	// with use_skill (across the WHOLE store — use_skill activates skills
	// that are not active yet). Skills hidden from the AI (effective
	// usable deny/never) are absent.
	Listed map[string]bool
	// HasVisible reports whether ANY skill is listed to the AI. No listed
	// skill -> the use_skill tool does not even appear.
	HasVisible bool
	// Delivered names the skills whose body already rode a use_skill
	// tool_result THIS turn: the <skill> prefix omits them so the body
	// text appears exactly once per turn.
	Delivered map[string]bool
}

// Resolve computes the effective skill state from the session's active
// skills. The session MODE is passed in, not derived: the frontend owns
// mode derivation (primary skill's `mode:`) and the daemon only validates
// the enum (anything but "agentic" falls back to "talk"). A skill whose
// name is missing from the store is skipped (its file may have been
// deleted from the daemon's skill dir); usable:never skills are base-only
// and are ignored as direct selections (they contribute only through
// another module imports them).
func Resolve(store map[string]Skill, active map[string]SessionSkill, mode string) (Effective, error) {
	eff := Effective{
		Bodies: map[string]string{},
		Listed: map[string]bool{},
	}

	names := make([]string, 0, len(active))
	for name, s := range active {
		if !s.Active {
			continue
		}
		sk, ok := store[name]
		if !ok {
			continue // deleted skill never breaks a session
		}
		if usable, err := UsableValue(sk, ""); err == nil && usable == "never" {
			continue // base-only: invisible even to the user
		}
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		if active[names[i]].Priority != active[names[j]].Priority {
			return active[names[i]].Priority < active[names[j]].Priority
		}
		return names[i] < names[j]
	})

	// The mode is caller-supplied (frontend-derived): the daemon only
	// validates the enum — anything but "agentic" is "talk". Only the
	// approvalMode still comes from the PRIMARY skill (first active by
	// priority): it is a property of the skill, not a mode derivation.
	if mode == "agentic" {
		eff.Mode = "agentic"
	} else {
		eff.Mode = "talk"
	}
	if len(names) > 0 {
		eff.AskAutoApprove = store[names[0]].ApprovalMode == "yolo"
	}

	// Prefix order is the user's selection by priority: a skill's body is
	// its own (a base body it wants to keep is concatenated in JS, so it
	// is already part of that body).
	seen := map[string]bool{}
	for _, name := range names {
		if seen[name] {
			continue
		}
		sk, ok := store[name]
		if !ok {
			continue // deleted skill never breaks a session
		}
		seen[name] = true
		eff.Order = append(eff.Order, name)
		eff.Bodies[name] = sk.Body
	}

	// Model-facing listing: every skill the AI may activate with use_skill
	// — effective usable (file original + session override) ask/yolo only;
	// deny/never stay hidden. Across the whole store (use_skill activates
	// skills that are not active yet). Skills pinned to another mode
	// never show.
	eff.Delivered = map[string]bool{}
	for name, sk := range store {
		usable, err := UsableValue(sk, active[name].Usable)
		if err != nil || usable == "deny" || usable == "never" {
			continue // AI-hidden
		}
		if sk.Mode != "" && eff.Mode != "" && sk.Mode != eff.Mode {
			continue // another mode's skill
		}
		eff.Listed[name] = true
	}
	eff.HasVisible = len(eff.Listed) > 0
	// Delivered view: active skills whose body already rode a tool_result.
	for _, name := range eff.Order {
		if active[name].InContext {
			eff.Delivered[name] = true
		}
	}

	// Resolution chain: HIGHEST scope first (last active skill first). The
	// first explicit entry wins; the universal fallback is deny.
	chainSeen := map[string]bool{}
	for i := len(names) - 1; i >= 0; i-- {
		name := names[i]
		if chainSeen[name] {
			continue
		}
		sk, ok := store[name]
		if !ok {
			continue
		}
		chainSeen[name] = true
		eff.Chain = append(eff.Chain, sk)
	}
	return eff, nil
}

// ToolDecision resolves one tool's policy: the first scope in the chain
// with an explicit (non-inherit) entry decides. Tools no scope lists are
// denied — the base is deny for everything not granted explicitly.
func (eff Effective) ToolDecision(tool string) Policy {
	for _, sk := range eff.Chain {
		spec, ok := sk.Permissions[tool]
		if !ok {
			continue
		}
		if spec.Policy == PolicyInherit || spec.Policy == "" {
			continue // bare `tool:` entry = inherit: keep walking
		}
		return spec.Policy
	}
	return PolicyDeny
}

// ArgDecision resolves one ARGUMENT KEY of a tool. The arg dimension is
// looked up across the WHOLE chain first (highest scope with an explicit
// arg entry wins); a key no scope configures inherits the tool's own
// resolved policy (arg -> tool -> chain -> deny). Overrides scope to the
// argument KEY only — they never inspect the argument's value or content.
func (eff Effective) ArgDecision(tool, argKey string) Policy {
	for _, sk := range eff.Chain {
		spec, ok := sk.Permissions[tool]
		if !ok {
			continue
		}
		if p, found := spec.Args[argKey]; found && p != PolicyInherit && p != "" {
			return p
		}
	}
	return eff.ToolDecision(tool)
}

// UsableValue resolves a session's usable override for one skill against
// the skill file's ORIGINAL, enforcing the locks of the usability table.
//
// The file original is ask, yolo, deny or never — there is no file-level
// "inherit": when the skill module omits `usable` the original is deny. At session
// level, an empty override and an explicit "inherit" both mean NO
// override: the original applies untouched. Locked originals win over any
// explicit session value:
//
//	original deny  (incl. key omitted) -> locked "deny" (hidden from the
//	                   AI; the user may still activate it from the frontend)
//	original never -> locked "never" (base-only: invisible to the AI AND
//	                   to the user's frontend)
//	original yolo  -> locked "yolo"
//	original ask   -> "ask" | "yolo" | "deny"
//
// The result is therefore never "inherit": it is the effective activation
// policy. Invalid file or session values are reported as errors.
func UsableValue(sk Skill, override string) (string, error) {
	base := sk.Usable
	if base == "" {
		base = "deny"
	}
	switch base {
	case "deny", "never", "yolo":
		// Locked: any override is ignored (the lock wins).
		return base, nil
	case "ask":
	default:
		return "", fmt.Errorf("skill usable must be ask, yolo, deny or never, got %q", sk.Usable)
	}
	switch override {
	case "", "inherit":
		return base, nil
	case "ask", "yolo", "deny":
		return override, nil
	}
	return "", fmt.Errorf("usable override must be inherit, ask, yolo or deny, got %q", override)
}
