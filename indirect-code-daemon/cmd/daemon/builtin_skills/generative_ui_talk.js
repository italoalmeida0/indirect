import generativeUI from "skill:generative_ui";

/* A talk session has no workspace, so a widget arrives as source text inside
   the reply: the design-system base applies, with the src_file argument
   denied. The base grants widget_set as the bare policy "yolo"; here it grows
   an argument override, so the granted policy is restated explicitly. */
export default {
  ...generativeUI,
  name: "generative_ui_talk",
  description: "Generative UI delivery for talk sessions (the block lives in the reply text).",
  usable: "deny",
  permissions: {
    ...generativeUI.permissions,
    widget_set: {
      policy: generativeUI.permissions.widget_set,
      args: {
        src_file: "deny",
      },
    },
  },
  body: `Where the block must live (important): write the block directly in your reply text. A generative_ui block written anywhere else (files, tool output) is never rendered. The design system below applies to that widget.
` + generativeUI.body,
};
