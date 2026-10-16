package main

import (
	"fmt"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/skills"
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
// part here. A skill whose body already rode a use_skill tool_result THIS
// turn is not re-sent: the tool answers with a short delivered ack instead
// (the body text appears exactly once per turn).
func (w *turnBridge) LoadSkill(name string) (string, error) {
	sk, ok := skillRegistry.get(name)
	if !ok {
		return "", fmt.Errorf("unknown skill (ask the user to check the skill name)")
	}
	usable, err := skills.UsableValue(sk, w.skillUsableOverride(name))
	if err != nil {
		return "", err
	}
	switch usable {
	case "deny", "never":
		// deny: AI cannot load it (the user may still activate it from the
		// frontend). never: base-only — not even the user sees it, it
		// contributes exclusively through another skill's inherit list.
		return "", fmt.Errorf("skill is not available")
	}
	if w.skillEff.Delivered[name] {
		return "<skill id=\"" + name + "\" loaded and active>", nil
	}
	return sk.Body, nil
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
// the skill is active + in-context + byAI from this call on, so the next
// request's <skill> prefix omits its body (it already rode the
// tool_result). Turn-end bookkeeping (once deactivation, artifact drop,
// marker reset) is the actor's job.
func (w *turnBridge) RecordSkillUse(name string, once bool) string {
	// The session override rides through VERBATIM: an empty/"inherit"
	// override stays an override-less entry (the file original keeps
	// applying) instead of being frozen to today's resolved value.
	usable := w.skillUsableOverride(name)
	w.sendInbox(w.stamp(skillActivateMsg{gen: w.snap.gen, name: name, once: once, usable: usable}))
	w.skillUses = append(w.skillUses, skillUseRecord{name: name, once: once})
	return name
}

// resolveSkillPolicy computes the effective skill policy for this turn and
// projects it onto the registry. Called at turn start and again on every
// mid-turn refresh (the skill map can change live). The resolved policy
// drives the tool list, the approval gate and the ephemeral prefix; the
// MODE is the session's own mode (snapshot options, frontend-derived).
func (w *turnBridge) resolveSkillPolicy() error {
	eff, err := skillRegistry.resolveSession(w.snap.skills, w.snap.options.Mode)
	if err != nil {
		return err
	}
	w.skillEff = eff
	return nil
}

// effectiveRegistry combines the base mode allowlist with the resolved
// skill policy: denied tools vanish from the model-facing registry. The
// use_skill tool carries the live skill listing (ask/yolo only).
func (w *turnBridge) effectiveRegistry() core.Registry {
	reg := skillsRegistry(modeRegistry(w.reg, w.skillEff.Mode), w.skillEff)
	if t, ok := reg["use_skill"].(*tools.UseSkillTool); ok {
		t.Listing = skillRegistry.skillsDescription(w.skillEff.Mode, w.snap.skills)
	}
	return reg
}
