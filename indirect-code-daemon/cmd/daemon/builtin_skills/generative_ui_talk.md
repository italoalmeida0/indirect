---
name: generative_ui_talk
description: Generative UI delivery for talk sessions (the block lives in the reply text).
inherit: [generative_ui]
tools:
  permissions:
    widget_set: inherit { src_file: deny }
---
Where the block must live (important): write the block directly in your reply text. A generative_ui block written anywhere else (files, tool output) is never rendered. The design system below applies to that widget.

