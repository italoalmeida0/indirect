/**
 * Canonical reasoning effort levels offered by the UI. The daemon accepts
 * these (and more aliases); providers clamp them internally (see
 * indirect-code-daemon/packages/provider/reasoning.go). "none" is an explicit
 * off — NormalizeReasoning maps it to the disabled state.
 */
export const REASONING_LEVELS = ["none", "minimum", "low", "medium", "high", "xhigh", "max"] as const;

export const REASONING_LABELS: Record<string, string> = {
  none: "OFF",
  off: "OFF",
  minimum: "MIN",
  min: "MIN",
  low: "LOW",
  medium: "MED",
  med: "MED",
  medi: "MED",
  high: "HIGH",
  xhigh: "XHIGH",
  max: "MAX",
};

/**
 * Slash command definitions for autocomplete palette.
 * Only commands NOT already configurable somewhere in the UI are listed:
 * model + reasoning effort live in the composer picker,
 * and help live in the surrounding UI.
 */
export const SLASH_COMMANDS = [
  {
    cmd: "/auto",
    desc: "Sandboxed Auto mode: allow safe workspace actions, ask on risky or outside operations",
    args: "",
  },
  {
    cmd: "/ask",
    desc: "Ask for approval: sandbox workspace and ask before edits or commands",
    args: "",
  },
  {
    cmd: "/full",
    desc: "Full access mode: unrestricted workspace & host access without approval prompts",
    args: "",
  },
  {
    cmd: "/compact",
    desc: "Compact conversation transcript to free up context tokens",
    args: "",
  },
  {
    cmd: "/clear",
    desc: "Start a fresh blank session (history is kept)",
    args: "",
  },
];

