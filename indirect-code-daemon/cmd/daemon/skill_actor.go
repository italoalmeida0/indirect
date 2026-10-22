package main

import (
	"encoding/json"
	"time"

	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/skills"
)

// onSkillActivate applies a use_skill activation immediately (mid-turn).
// The skill joins the session's skill map marked active + byAI + inContext:
// its body rode the tool_result for immediate use this turn, so the
// rebuilt <skill> prefix (next request) never repeats it. with once=true
// the skill is deactivated again at turn end (finishTurn). The transcript
// is untouched here — the use_skill call/result pair is stripped before
// the turn commits (stripSkillArtifacts).
func (a *sessionActor) onSkillActivate(m skillActivateMsg) {
	if m.gen != a.gen || m.name == "" {
		return
	}
	if _, ok := skillRegistry.get(m.name); !ok {
		return
	}
	a.touch()
	if a.rec.Skills == nil {
		a.rec.Skills = map[string]skills.SessionSkill{}
	}
	st := a.rec.Skills[m.name]
	st.Active = true
	st.ByAI = true // last activation is the AI's: user deactivation notices
	st.Once = m.once
	st.InContext = true // the body rode the tool_result this turn
	if st.Priority == 0 {
		st.Priority = len(a.rec.Skills) + 1
	}
	if st.Usable == "" {
		st.Usable = m.usable
	}
	a.rec.Skills[m.name] = st
	a.saveSkills()
}

// onSkillsUpdate applies a granular frontend skill edit: per-skill set/unset
// of active + usable, plus a full reorder for drag-to-sort. Ingestion is
// passive (the frontend owns validation): unknown names drop silently, a
// missing usable means inherit, a present usable is stored VERBATIM. A
// user (re)activation is persistent — it clears the once marker and
// records the user as the activation source. The session MODE is NOT
// touched here: it arrives via configure (the frontend re-derives it
// from the primary skill whenever the selection changes).
func (a *sessionActor) onSkillsUpdate(m skillsUpdateMsg) {
	a.touch()
	if a.rec.Skills == nil {
		a.rec.Skills = map[string]skills.SessionSkill{}
	}
	for name, upd := range m.Set {
		if _, ok := skillRegistry.get(name); !ok {
			continue
		}
		st := a.rec.Skills[name]
		// Passive: the usable override is stored verbatim (missing key =
		// "" = inherit the skill file's default at resolve time).
		usable := upd.Usable
		switch {
		case upd.Active && !st.Active:
			// User activation: persistent, never once; the user is the
			// activation source. InContext stays as it is — a skill whose
			// body already rode this turn's context is not re-sent.
			st.ByAI = false
			st.Once = false
		case !upd.Active && st.Active:
			// User deactivation of an AI-activated skill: the AI gets one
			// ephemeral notice (pendingContext, never persisted). The
			// deactivation clears ByAI, so a second deactivation after
			// re-activation never notices again.
			if st.ByAI {
				a.noticeSkillDeactivation(name)
			}
			st.ByAI = false
			st.Once = false
		}
		st.Active = upd.Active
		st.Usable = usable
		a.rec.Skills[name] = st
	}
	for _, name := range m.Unset {
		st, ok := a.rec.Skills[name]
		if !ok {
			continue
		}
		if st.Active && st.ByAI {
			a.noticeSkillDeactivation(name)
		}
		delete(a.rec.Skills, name)
	}
	if len(m.Order) > 0 {
		prio := 1
		seen := map[string]bool{}
		for _, name := range m.Order {
			st, ok := a.rec.Skills[name]
			if !ok || seen[name] {
				continue
			}
			seen[name] = true
			st.Priority = prio
			a.rec.Skills[name] = st
			prio++
		}
		// Anything the reorder did not name keeps its relative position at
		// the tail (stable by current priority, then name).
		rest := make([]string, 0, len(a.rec.Skills)-len(seen))
		for name := range a.rec.Skills {
			if !seen[name] {
				rest = append(rest, name)
			}
		}
		sortSkillsByNamePriority(a.rec.Skills, rest)
		for _, name := range rest {
			st := a.rec.Skills[name]
			st.Priority = prio
			a.rec.Skills[name] = st
			prio++
		}
	}
	a.saveSkills()
	// Complete snapshot back to the client (same shape as the mirror pull).
	a.emit(map[string]any{"type": "session_data", "hostId": a.hostID(), "session": pagedHistoryBlock(sessionPayload(a.rec), a.rec)})
}

// noticeSkillDeactivation queues the ephemeral system notice for the AI:
// the user deactivated a skill the AI activated this turn. The notice
// lives only in pendingContext (request-side); it is never persisted and
// is dropped at turn end when no request consumes it.
func (a *sessionActor) noticeSkillDeactivation(name string) {
	if a.state != stateRunning && a.state != stateAwaitAppr && a.state != stateAwaitQ {
		return // no worker to tell — the notice is turn-scoped
	}
	a.pendingContext = append(a.pendingContext, skillNoticeMessage(name))
}

// saveSkills persists the session skill map (full-replace WAL event) and
// pings the mirror.
func (a *sessionActor) saveSkills() {
	a.rec.UpdatedAt = time.Now().UnixMilli()
	_ = a.saveOrAppend(walEvent{Type: walTypeSkills, Skills: cloneSkillsMap(a.rec.Skills), UpdatedAt: a.rec.UpdatedAt})
	a.pingChange()
}

// endTurnSkills runs the turn-end skill rules: every once skill
// deactivates and the daemon-owned turn markers (once/inContext/byAI)
// reset — they only describe THIS turn. Reports whether anything changed.
func (a *sessionActor) endTurnSkills() bool {
	changed := false
	for name, st := range a.rec.Skills {
		if !st.Once && !st.InContext {
			continue
		}
		if st.Once {
			st.Active = false
		}
		st.Once, st.InContext = false, false
		a.rec.Skills[name] = st
		changed = true
	}
	return changed
}

// stripSkillArtifacts removes the CURRENT turn's use_skill tool
// calls/results — and the ephemeral skill-deactivation notices — from the
// message list before the turn commits. The skill bodies live in the
// ephemeral <skill> prefix of the turns where the skill is active, so the
// raw activation artifacts must never join the persisted context (they
// would duplicate the body forever); notices are request-only by
// contract. Only messages of turn turnIdx are touched: older committed
// turns may carry their own pre-folded placeholders and stay as they are.
func stripSkillArtifacts(msgs []provider.Message, turnIdx int) []provider.Message {
	out := make([]provider.Message, 0, len(msgs))
	for _, msg := range msgs {
		if msg.TurnIndex != turnIdx {
			out = append(out, msg)
			continue
		}
		if _, isNotice := msg.Meta[skillNoticeMetaKey]; isNotice {
			continue // ephemeral notice: never committed
		}
		content := make([]provider.Content, 0, len(msg.Content))
		for _, c := range msg.Content {
			switch block := c.(type) {
			case provider.ToolCallBlock:
				if block.Name == "use_skill" {
					continue
				}
			case provider.ToolResultBlock:
				if isUseSkillResult(block) {
					continue
				}
			}
			content = append(content, c)
		}
		if len(content) == 0 {
			continue
		}
		msg.Content = content
		out = append(out, msg)
	}
	return out
}

func skillNameFromDetails(details any) string {
	switch d := details.(type) {
	case map[string]any:
		if s, ok := d["skill"].(string); ok {
			return s
		}
	case json.RawMessage:
		var m map[string]any
		if err := json.Unmarshal(d, &m); err == nil {
			if s, ok := m["skill"].(string); ok {
				return s
			}
		}
	case []byte:
		var m map[string]any
		if err := json.Unmarshal(d, &m); err == nil {
			if s, ok := m["skill"].(string); ok {
				return s
			}
		}
	case string:
		var m map[string]any
		if err := json.Unmarshal([]byte(d), &m); err == nil {
			if s, ok := m["skill"].(string); ok {
				return s
			}
		}
	}
	return ""
}

// isUseSkillResult reports whether a tool result belongs to any use_skill
// call. Matching rides on the Details marker stamped by the tool result
// envelope (never on body text).
func isUseSkillResult(res provider.ToolResultBlock) bool {
	return skillNameFromDetails(res.Details) != ""
}

// isUseSkillResultFor reports whether a tool result belongs to a use_skill
// call of the named skill.
func isUseSkillResultFor(res provider.ToolResultBlock, name string) bool {
	return skillNameFromDetails(res.Details) == name
}

// sortSkillsByNamePriority orders names by their stored priority (then
// name) so an unnamed tail keeps its relative position after a reorder.
func sortSkillsByNamePriority(m map[string]skills.SessionSkill, names []string) {
	for i := 1; i < len(names); i++ {
		for j := i; j > 0; j-- {
			a, b := m[names[j-1]], m[names[j]]
			if a.Priority < b.Priority || (a.Priority == b.Priority && names[j-1] <= names[j]) {
				break
			}
			names[j-1], names[j] = names[j], names[j-1]
		}
	}
}

// useSkillUsableGate applies the usability table to a use_skill call
// (file original + session override, via UsableValue): "deny"/"never"
// refuse, "yolo" approves free, "ask" forces human approval. The session
// approvalMode NEVER influences this gate: there is no effective
// "inherit" left to resolve — a session "inherit" (or missing usable)
// simply means the file original applies, and a file without a usable
// key has deny as its original. Unknown skills return "" and leave the
// decision to the tool itself (its error surface is better than a
// generic refusal).
func useSkillUsableGate(active map[string]skills.SessionSkill, args json.RawMessage) (verdict string, reason string) {
	var parsed struct {
		Name string `json:"name"`
	}
	if len(args) > 0 {
		_ = json.Unmarshal(args, &parsed)
	}
	sk, ok := skillRegistry.get(parsed.Name)
	if !ok {
		return "", ""
	}
	usable, err := skills.UsableValue(sk, active[parsed.Name].Usable)
	if err != nil {
		return "refuse", err.Error()
	}
	switch usable {
	case "deny", "never":
		return "refuse", "skill is not available"
	case "ask":
		return "ask", ""
	case "yolo":
		return "approve", ""
	default: // unreachable: UsableValue only returns the four originals
		return "refuse", "skill is not available"
	}
}
