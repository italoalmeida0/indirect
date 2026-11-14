export type MidTurnDelivery = "queue" | "steer" | "interrupt";
export type AccessMode = "ask" | "auto" | "full";
export type PermissionEffect = "allow" | "deny";
export type PermissionCapability = "exec" | "fs_read" | "fs_write" | "net" | "tool";
export type ApprovalDecision = "once" | "session" | "always" | "deny";

export interface PermissionRule {
  id: string;
  effect: PermissionEffect;
  kind: PermissionCapability;
  pattern: string;
  label?: string;
  createdAt?: number;
}

/** Check whether a raw wire value is one of the 3 canonical access modes. */
export function isValidAccessMode(value: unknown): value is AccessMode {
  if (typeof value !== "string") return false;
  const s = value.trim().toLowerCase();
  return s === "ask" || s === "auto" || s === "full";
}

/** Normalize an access mode from session options or wire payloads. */
export function normalizeAccessMode(
  value: unknown,
  fallback: AccessMode = "auto",
): AccessMode {
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "ask" || s === "auto" || s === "full") return s;
  }
  return fallback;
}

/** Resolve host default access mode from mirrored daemon settings.
 * Explicit `default_access` wins; otherwise `jail_by_default !== false` maps to
 * `"auto"` (including fresh/unloaded hosts), and explicit `jail_by_default === false`
 * maps to `"full"`. */
export function resolveDefaultAccess(
  settings?: Record<string, unknown> | null,
): AccessMode {
  if (!settings || typeof settings !== "object") return "auto";
  const explicit = settings.defaultAccess ?? settings.default_access;
  if (isValidAccessMode(explicit)) return normalizeAccessMode(explicit, "auto");
  const jail = settings.jailByDefault ?? settings.jail_by_default;
  if (jail === false) return "full";
  return "auto";
}

export function normalizePermissionEffect(value: unknown): PermissionEffect {
  return value === "deny" ? "deny" : "allow";
}

export function normalizePermissionCapability(
  value: unknown,
): PermissionCapability {
  if (
    value === "exec" ||
    value === "fs_read" ||
    value === "fs_write" ||
    value === "net" ||
    value === "tool"
  ) {
    return value;
  }
  return "exec";
}

export function normalizePermissionRule(
  raw: unknown,
  fallbackIdx = 0,
): PermissionRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pattern = typeof r.pattern === "string" ? r.pattern.trim() : "";
  if (!pattern) return null;
  const id =
    typeof r.id === "string" && r.id.trim()
      ? r.id.trim()
      : `rule_${fallbackIdx}`;
  const effect = normalizePermissionEffect(r.effect);
  const kind = normalizePermissionCapability(r.kind);
  const label =
    typeof r.label === "string" && r.label.trim() ? r.label.trim() : undefined;
  const rawCreated = r.createdAt ?? r.created_at;
  const createdAt =
    typeof rawCreated === "number" &&
    Number.isFinite(rawCreated) &&
    rawCreated > 0
      ? rawCreated
      : undefined;
  return {
    id,
    effect,
    kind,
    pattern,
    ...(label ? { label } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

export function normalizePermissionRules(raw: unknown): PermissionRule[] {
  if (!Array.isArray(raw)) return [];
  const out: PermissionRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const rule = normalizePermissionRule(raw[i], i);
    if (rule) out.push(rule);
  }
  return out;
}

export function arePermissionRulesEqual(
  a?: readonly PermissionRule[],
  b?: readonly PermissionRule[],
): boolean {
  if (a === b) return true;
  const listA = a ?? [];
  const listB = b ?? [];
  if (listA.length !== listB.length) return false;
  for (let i = 0; i < listA.length; i++) {
    const ra = listA[i]!;
    const rb = listB[i]!;
    if (
      ra.id !== rb.id ||
      ra.effect !== rb.effect ||
      ra.kind !== rb.kind ||
      ra.pattern !== rb.pattern ||
      (ra.label || "") !== (rb.label || "")
    ) {
      return false;
    }
  }
  return true;
}

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
