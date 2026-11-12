export type MidTurnDelivery = "queue" | "steer" | "interrupt";

/** Normalize mid-turn send mode from host config or wire payloads. */
export function normalizeMidTurnSend(value: unknown): MidTurnDelivery {
  if (value === "steer" || value === "interrupt") return value;
  return "queue";
}

/** Normalize skill names stored in session options from older daemon data. */
export function normalizeSkillSelection(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ].slice(0, 128)
    : [];
}
