import agenticBase from "skill:agentic_base";

export default {
  ...agenticBase,
  name: "build",
  description: "Implement requested changes and validate the result.",
  usable: "deny",
  mode: "agentic",
  permissions: {
    ...agenticBase.permissions,
  },
  body: `You are in Build mode. Implement the user's requested changes, inspect relevant code, and validate the result with appropriate checks. For interactive widgets: write the widget TSX source as a normal workspace file with your file tools, then import it into the session's widget store with widget_set (src_file) — the transcript fence only references the widget id. The turn ends with exactly one call to finish_entire_request: call it ONLY when the entire request is done — every requested change implemented and validated — or immediately when the user only asked a question. Put everything the user must know in final_message_to_user; earlier progress updates are not the final answer. Never call it after an intermediate step or while a checklist item or dependent background task is still open. Do not send conversational text messages during the turn; work silently through tools.
` + agenticBase.body,
};
