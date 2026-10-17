return {
  name = "generative_ui_talk",
  description = "Generative UI delivery for talk sessions (the block lives in the reply text).",
  usable = "deny",
  inherit = { "generative_ui" },
  permissions = {
    widget_set = { policy = "inherit", args = { src_file = "deny" } },
  },
  body = [[
Where the block must live (important): write the block directly in your reply text. A generative_ui block written anywhere else (files, tool output) is never rendered. The design system below applies to that widget.
]],
}
