package main

import (
	"strings"

	"indirect/indirect-code-daemon/packages/provider"
	"indirect/indirect-code-daemon/packages/skills"
)

// skillPrefixMetaKey marks the current turn's user message: the ephemeral
// <skill> prefix is injected before its text at REQUEST time and never
// persisted (spec: prefix is built on the fly, outside the stored history).
const skillPrefixMetaKey = "skill_prefix"

// buildSkillPrefix renders the active skills as <skill id="...">body</skill>
// blocks in priority order. Skills whose body already rode a use_skill
// tool_result THIS turn (eff.Delivered) are excluded: the body text appears
// exactly once per turn. Empty when nothing is left to inject.
func buildSkillPrefix(eff skills.Effective) string {
	if len(eff.Order) == 0 {
		return ""
	}
	var b strings.Builder
	for _, name := range eff.Order {
		if eff.Delivered[name] {
			continue // body already in context via use_skill tool_result
		}
		body, ok := eff.Bodies[name]
		if !ok {
			continue
		}
		b.WriteString("<skill id=\"")
		b.WriteString(name)
		b.WriteString("\">")
		b.WriteString(body)
		b.WriteString("</skill>\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// injectSkillsPrefix prepends the ephemeral skill blocks to the current
// turn's user message inside the REQUEST-ONLY message list. The transcript
// copy is untouched: skill prefixes never join the persisted history and
// the injection point (the marked user message) is stable across the
// tool loop, so the prompt cache sees the same prefix position all turn.
func injectSkillsPrefix(msgs []provider.Message, prefix string) []provider.Message {
	if prefix == "" {
		return msgs
	}
	out := make([]provider.Message, len(msgs))
	copy(out, msgs)
	for i := len(out) - 1; i >= 0; i-- {
		if out[i].Role != provider.RoleUser {
			continue
		}
		if out[i].Meta[skillPrefixMetaKey] != "1" {
			continue
		}
		content := make([]provider.Content, 0, len(out[i].Content)+1)
		content = append(content, provider.TextBlock{Text: prefix})
		content = append(content, out[i].Content...)
		out[i].Content = content
		return out
	}
	return msgs
}

// markTurnPrompt tags the meta map of the current turn's user message so
// injectSkillsPrefix finds it after projection/prune/compaction.
func markTurnPrompt(meta map[string]string) {
	if meta == nil {
		return
	}
	meta[skillPrefixMetaKey] = "1"
}

// skillActivateMsg asks the actor to apply a use_skill activation
// immediately (mid-turn): the skill joins the session's skill map marked
// active + inContext (its body rode the tool_result) + byAI, with the once
// marker when requested. The map change is persisted and mirrored to the
// frontend right away (the UI shows the skill active mid-turn); only the
// tool call/result pair is ephemeral (stripped before commit).
type skillActivateMsg struct {
	gen  int
	name string
	// once marks an AI activation with once=true (deactivated at turn end).
	once bool
	// usable override to store ("" keeps the skill default).
	usable string
}

// skillNoticeMessage builds the ephemeral system notice emitted when the
// user deactivates a skill whose last activation was the AI's (this turn).
// The message is request-only context (pendingContext): it never joins the
// persisted transcript.
func skillNoticeMessage(name string) provider.Message {
	return provider.Message{
		ID:      provider.NewMessageID(),
		Role:    provider.RoleUser,
		Content: []provider.Content{provider.TextBlock{Text: "[system notice] The user deactivated the skill " + name + " that you loaded this turn; its instructions no longer apply."}},
		Meta:    map[string]string{skillNoticeMetaKey: name},
	}
}

// skillNoticeMetaKey tags the ephemeral skill-deactivation notices.
const skillNoticeMetaKey = "skill_notice"

// skillFoldPlaceholder is the folded body of a persisted use_skill result.
func skillFoldPlaceholder(name string) string {
	return "<skill id=\"" + name + "\" loaded and active>"
}
