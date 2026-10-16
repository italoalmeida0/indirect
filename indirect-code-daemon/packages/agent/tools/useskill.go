package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// UseSkillHost is the daemon bridge: look up a skill, run its activation
// policy and record the activation immediately (the actor marks the skill
// active + in-context; turn-end bookkeeping is the actor's job).
type UseSkillHost interface {
	// LoadSkill returns the skill body (or an already-loaded ack) for
	// name. The host has already enforced the usable policy (approval)
	// before Execute runs.
	LoadSkill(name string) (body string, err error)
	// RecordSkillUse notes a use_skill invocation: the activation lands in
	// the session record immediately (active + in-context + byAI, with the
	// once marker when requested) and the returned name marks the
	// tool_result so the turn's activation artifacts can be dropped before
	// the context commits.
	RecordSkillUse(name string, once bool) string
}

// UseSkillTool loads one skill on demand. The body is returned inside the
// tool_result for immediate use THIS turn; from the next request on the
// skill rides the ephemeral <skill> prefix (and is then omitted from the
// tool_result side to keep the text unique per turn).
type UseSkillTool struct {
	Host UseSkillHost
	// Listing is the model-facing skill listing appended to the tool
	// description (rebuilt per request: only skills whose effective usable
	// is ask/yolo show).
	Listing string
}

type useSkillArgs struct {
	Name string `json:"name"`
	Once bool   `json:"once"`
}

const useSkillArgsJSON = `{"type":"object","properties":{"name":{"type":"string","description":"The skill name, exactly as listed in the tool description."},"once":{"type":"boolean","description":"true loads the skill for THIS turn only (deactivated at turn end). false/omitted activates it for the rest of the session."}},"required":["name"]}`

const useSkillBaseDescription = "Load one skill by name. On success the skill's full instruction body is returned inside the tool_result for immediate use this turn; it also stays active for the session (injected as a <skill> block in later requests). With once=true it applies to this turn only. Loading an already-loaded skill just acknowledges it."

func (*UseSkillTool) Name() string { return "use_skill" }

func (t *UseSkillTool) Description() string {
	if t.Listing == "" {
		return useSkillBaseDescription
	}
	return useSkillBaseDescription + "\n\n" + t.Listing
}

func (*UseSkillTool) Schema() json.RawMessage { return json.RawMessage(useSkillArgsJSON) }

func (t *UseSkillTool) Execute(_ context.Context, args json.RawMessage, _ func(string)) (core.ToolResult, error) {
	var parsed useSkillArgs
	if len(args) > 0 {
		if err := json.Unmarshal(args, &parsed); err != nil {
			return core.ToolResult{}, err
		}
	}
	if parsed.Name == "" {
		return core.ToolResult{}, fmt.Errorf("name is required")
	}
	body, err := t.Host.LoadSkill(parsed.Name)
	if err != nil {
		return core.ToolResult{}, fmt.Errorf("skill %q: %w", parsed.Name, err)
	}
	name := t.Host.RecordSkillUse(parsed.Name, parsed.Once)
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: body}},
		Attrs:   []core.Attr{{Key: "skill", Value: name}},
		// Details is frontend/actor-only (never sent to the model): the
		// actor matches this result by name to drop the activation
		// artifacts before the turn commits.
		Details: map[string]any{"skill": name},
	}, nil
}
