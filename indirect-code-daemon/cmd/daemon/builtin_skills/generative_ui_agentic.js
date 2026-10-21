import generativeUI from "skill:generative_ui";

export default {
  ...generativeUI,
  name: "generative_ui_agentic",
  description: "Generative UI delivery for agentic sessions (the block lives in the final answer).",
  usable: "never",
  permissions: {
    ...generativeUI.permissions,
    widget_read: "deny",
    widget_edit: "deny",
  },
  body: `Where the block must live (important): the widget is only mounted when it appears in your final answer — the \`final_message_to_user\` field of the \`finish_entire_request\` call. A generative_ui block emitted anywhere else (intermediate assistant text, tool results, files) is never rendered. So write the whole widget inside \`final_message_to_user\` and nowhere else. The design system below applies to that widget.
` + generativeUI.body,
};
