import generativeUI from "skill:generative_ui";

/* Opt-in widget delivery for agentic sessions. The agentic mode skills do
   not import it (widgets are not part of the default agentic toolset); the
   user adds it per session from the skill picker (usable "deny": visible
   and selectable for the user, hidden from use_skill). It keeps the design
   system of generative_ui, narrows the talk-only source tools, and carries
   the agentic delivery rules: source written as a workspace file, imported
   with widget_set src_file, block placed in final_message_to_user. */
export default {
  ...generativeUI,
  name: "generative_ui_agentic",
  description: "Interactive widgets (charts, calculators, dashboards) delivered in the final answer of agentic sessions.",
  usable: "deny",
  mode: "agentic",
  permissions: {
    ...generativeUI.permissions,
    widget_read: "deny",
    widget_edit: "deny",
  },
  body: `Where the block must live (important): the widget is only mounted when it appears in your final answer — the \`final_message_to_user\` field of the \`finish_entire_request\` call. A generative_ui block emitted anywhere else (intermediate assistant text, tool results, files) is never rendered. So write the whole widget inside \`final_message_to_user\` and nowhere else. To create or change a widget, write its TSX source as a normal workspace file with your file tools, then import it into the session's widget store with widget_set (src_file) — the transcript fence only references the widget id. The design system below applies to that widget.
` + generativeUI.body,
};
