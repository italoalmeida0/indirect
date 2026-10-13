package main

import (
	_ "embed"
	"fmt"
	"strings"
)

// generativeUiPrompt is the embedded Generative UI design-system skill. The
// widget is a markdown DSL, not a tool call: the assistant writes a fenced
// code block tagged generative_ui and the transcript renderer mounts the live
// widget in place. Keep this in sync with
// web/src/indirect-code/components/generative-ui/dsl.ts and widget-doc.ts
// (WIDGET_BASE_CSS is the class library the prompt describes). Scope of the
// color/style rules, mirrored from the .md: they bind widget UI only — inside
// a <canvas> (2D/3D) any color is allowed, and games have no UI rules at all
// (custom CSS/elements welcome; a shell that mimics the game's original
// console is appreciated). Everything must work on both phones and desktops.
//
// Delivery note: the renderer only mounts blocks that reach the transcript
// through the assistant's final answer. That path differs per mode, so the
// note is generated per mode in generativeUiSection below (the shared .md
// must stay mode-clean: system prompts never name sibling modes). Nothing
// enforces the location technically — the note steers agents to the one
// working path.
//
//go:embed generative_ui_prompt.md
var generativeUiPrompt string

// generativeUiSection returns the Generative UI prompt for one mode: the
// shared design-system text with the mode-specific delivery note spliced in
// after the intro paragraph.
func generativeUiSection(mode string) string {
	var note string
	if modeCompletionTool(mode) == "" {
		note = "Where the block must live (important): write the block " +
			"directly in your reply text. A generative_ui block written " +
			"anywhere else (files, tool output) is never rendered.\n\n"
	} else {
		note = fmt.Sprintf("Where the block must live (important): the widget "+
			"is only mounted when it appears in your final answer — the `%s` "+
			"field of the %s call. A generative_ui block emitted anywhere "+
			"else (intermediate assistant text, tool results, files) is never "+
			"rendered. So write the whole widget inside `%s` and nowhere "+
			"else.\n\n", completionArgName(mode), modeCompletionTool(mode),
			completionArgName(mode))
	}
	const anchor = "\nEmit ONE fenced code block"
	if i := strings.Index(generativeUiPrompt, anchor); i >= 0 {
		return generativeUiPrompt[:i+1] + note + generativeUiPrompt[i+1:]
	}
	return note + generativeUiPrompt
}
