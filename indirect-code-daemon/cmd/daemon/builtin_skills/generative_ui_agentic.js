import generativeUI from "skill:generative_ui";

/* An agentic session delivers widgets through finish_entire_request, so the
   block must live in final_message_to_user — and the workspace-side widget
   tools would only waste a turn there. This module imports the design-system
   base, keeps its rules after its own, and narrows two permissions: spreading
   the base is what makes it a skill rather than a Go-side dependency. */
export default {
  ...generativeUI,
  name: "generative_ui_agentic",
  description: "Generative UI delivery for agentic sessions (the block lives in the final answer).",
  usable: "yolo",
  permissions: {
    ...generativeUI.permissions,
    widget_read: "deny",
    widget_edit: "deny",
  },
  body: `Where the block must live (important): the widget is only mounted when it appears in your final answer — the \`final_message_to_user\` field of the \`finish_entire_request\` call. A generative_ui block emitted anywhere else (intermediate assistant text, tool results, files) is never rendered. So write the whole widget inside \`final_message_to_user\` and nowhere else. The design system below applies to that widget.
` + generativeUI.body,
};
