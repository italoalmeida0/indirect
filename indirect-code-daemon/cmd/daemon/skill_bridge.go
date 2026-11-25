package main

import (
	"fmt"
	"strings"

	"indirect/indirect-code-daemon/packages/agent/tools"
	"indirect/indirect-code-daemon/packages/core"
	"indirect/indirect-code-daemon/packages/skills"
)

// skillUseRecord notes one use_skill call of this turn (kept on the worker
// for diagnostics/fold matching; the durable activation is the immediate
// skillActivateMsg).
type skillUseRecord struct {
	name string
	once bool
}

// LoadSkill implements tools.UseSkillHost: returns the skill body after the
// usable policy check (effective usable = file original + session
// override; a missing file usable is a deny original). "usable: deny"
// skills are invisible; "ask" requires human approval (the caller-approval
// route via approveTool); "yolo" runs free. The approvalMode never takes
// part here, and a skill pinned to another mode is never served. The body
// text appears exactly once per turn: when it is already in context — it
// rode an earlier use_skill tool_result, or the skill is active and its
// body is in this request's <skill> prefix — the tool answers with a short
// loaded ack instead.
func (w *turnBridge) LoadSkill(name string) (string, error) {
	sk, ok := skillRegistry().get(name)
	if !ok {
		return "", fmt.Errorf("unknown skill (ask the user to check the skill name)")
	}
	if !skillModeMatches(sk, w.skillEff.Mode) {
		return "", fmt.Errorf("skill is not available in this mode")
	}
	usable, err := skills.UsableValue(sk, w.skillUsableOverride(name))
	if err != nil {
		return "", err
	}
	switch usable {
	case "deny", "never":
		// deny: AI cannot load it (the user may still activate it from the
		// frontend). never: base-only — not even the user sees it, it
		// only contributes when another module imports it.
		return "", fmt.Errorf("skill is not available")
	}
	if !skills.RequirementsMet(sk, w.skillEff.Satisfied) {
		return "", fmt.Errorf("skill requires an active parent skill")
	}
	unlockedHint := formatUnlockedSkillsHint(skillRegistry().newlyUnlockedSkills(w.skillEff.Mode, w.snap.skills, name))
	if w.skillBodyInContext(name) {
		w.lastSkillDelivered = false
		ack := skillFoldPlaceholder(name)
		if unlockedHint != "" {
			return ack + "\n\n" + unlockedHint, nil
		}
		return ack, nil
	}
	if w.skillsSent == nil {
		w.skillsSent = map[string]bool{}
	}
	w.skillsSent[name] = true
	w.lastSkillDelivered = true
	body := sk.Body
	if unlockedHint != "" {
		if body == "" {
			body = unlockedHint
		} else {
			body = strings.TrimRight(body, "\n") + "\n\n" + unlockedHint
		}
	}
	return body, nil
}

// skillBodyInContext reports whether the skill's body is already in this
// turn's context: delivered by an earlier use_skill result (this turn's
// eff.Delivered, or an earlier call of this very worker the actor has not
// echoed back yet) or carried by the <skill> prefix of the current request
// (active skill in the resolved prefix order).
func (w *turnBridge) skillBodyInContext(name string) bool {
	if w.skillEff.Delivered[name] || w.skillsSent[name] {
		return true
	}
	for _, active := range w.skillEff.Order {
		if active == name {
			return true
		}
	}
	return false
}

// skillUsableOverride reads the session's usable override for one skill.
func (w *turnBridge) skillUsableOverride(name string) string {
	if st, ok := w.snap.skills[name]; ok {
		return st.Usable
	}
	return ""
}

// RecordSkillUse implements tools.UseSkillHost. The activation lands in the
// session record IMMEDIATELY (skillActivateMsg through the actor inbox):
// the skill is active + byAI from this call on, and in-context when its
// body rode this result, so the next request's <skill> prefix omits it.
// Turn-end bookkeeping (once deactivation, artifact drop, marker reset) is
// the actor's job. Always called right after LoadSkill on the same
// goroutine (UseSkillTool.Execute), which is what lastSkillDelivered
// relies on.
func (w *turnBridge) RecordSkillUse(name string, once bool) string {
	delivered := w.lastSkillDelivered
	w.lastSkillDelivered = false
	w.sendInbox(skillActivateMsg{gen: w.snap.gen, name: name, once: once, delivered: delivered})
	w.skillUses = append(w.skillUses, skillUseRecord{name: name, once: once})
	// Mirror the activation onto the worker's local snapshot immediately so
	// consecutive use_skill calls in the same assistant step see the newly
	// active parent (BeforeRequest overwrites w.snap.skills from the actor on
	// the next model step).
	nextSkills := cloneSkillsMap(w.snap.skills)
	if nextSkills == nil {
		nextSkills = map[string]skills.SessionSkill{}
	}
	st, exists := nextSkills[name]
	if !(st.Active && !st.ByAI) {
		st.ByAI = true
		st.Once = once
	}
	st.Active = true
	if delivered {
		st.InContext = true
	}
	if !exists || st.Priority == 0 {
		st.Priority = nextSkillPriority(nextSkills)
	}
	nextSkills[name] = st
	w.snap.skills = nextSkills
	_ = w.resolveSkillPolicy()
	return name
}

// resolveSkillPolicy computes the effective skill policy for this turn and
// projects it onto the registry. Called at turn start and again on every
// mid-turn refresh (the skill map can change live). The resolved policy
// drives the tool list, the approval gate and the ephemeral prefix; the
// MODE is the session's own mode (snapshot options, frontend-derived).
func (w *turnBridge) resolveSkillPolicy() error {
	eff, err := skillRegistry().resolveSession(w.snap.skills, w.snap.options.Mode)
	if err != nil {
		return err
	}
	w.skillEff = eff
	return nil
}

// effectiveRegistry combines the base mode allowlist with the resolved
// skill policy: denied tools vanish from the model-facing registry. The
// use_skill tool carries the live skill listing (ask/yolo only, respecting
// mode and parent gating) on a fresh tool instance so concurrent readers
// never race on Listing.
func (w *turnBridge) effectiveRegistry() core.Registry {
	reg := skillsRegistry(w.reg, w.skillEff)
	if t, ok := reg["use_skill"].(*tools.UseSkillTool); ok {
		reg["use_skill"] = &tools.UseSkillTool{
			Host:    t.Host,
			Listing: skillRegistry().skillsDescription(w.skillEff.Mode, w.snap.skills),
		}
	}
	return reg
}
