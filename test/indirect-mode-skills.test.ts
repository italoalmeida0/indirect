import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import {
  deriveSessionMode,
  effectiveModeSkills,
  ensureModeSkill,
  originalUsable,
  usableDiffers,
} from "../web/src/indirect-code/utils/modeSkills";
import { normalizeSession } from "../web/src/indirect-code/store/sessions";
import type { SkillConfig } from "../web/src/indirect-code/types";

const official = (over: Record<string, Partial<SkillConfig>>): Record<string, SkillConfig> => {
  const base = (name: string): SkillConfig => ({ name, description: `${name} official`, body: "", enabled: true });
  const out: Record<string, SkillConfig> = {};
  for (const [name, o] of Object.entries(over)) out[name] = { ...base(name), ...o };
  return out;
};

describe("effectiveModeSkills (cache -> official reconciliation)", () => {
  test("before the official list loads, the 4 cached skills render", () => {
    const list = effectiveModeSkills(undefined, false);
    expect(list.map((m) => m.name)).toEqual(["build", "plan", "talk", "learning"]);
    expect(list.find((m) => m.name === "talk")?.mode).toBe("talk");
    // The cache mirrors the talk builtin's approvalMode so the ASK/YOLO
    // selector already hides pre-load when talk is primary.
    expect(list.find((m) => m.name === "talk")?.approvalMode).toBe("yolo");
  });

  test("after load, official values win and missing/never entries hide", () => {
    const list = effectiveModeSkills(
      official({
        build: { description: "Build from daemon", mode: "agentic", approvalMode: "yolo" },
        talk: { mode: "talk" },
        plan: { usable: "never" },
        // learning: absent entirely (deleted on the daemon)
      }),
      true,
    );
    expect(list.map((m) => m.name)).toEqual(["build", "talk"]);
    const build = list[0];
    expect(build.description).toBe("Build from daemon");
    expect(build.approvalMode).toBe("yolo");
    // Label/icon stay frontend-owned.
    expect(build.label).toBe("Build");
    expect(build.icon).toBe("lucide:hammer");
  });

  test("loaded with none of the 4 existing yields an empty list", () => {
    expect(effectiveModeSkills(official({ custom: {} }), true)).toEqual([]);
  });
});

describe("ensureModeSkill (mandatory exclusive primary)", () => {
  const all = ["build", "plan", "talk", "learning"];

  test("inserts the first available mode skill when none is selected", () => {
    expect(ensureModeSkill(["custom"], all)).toEqual(["build", "custom"]);
    expect(ensureModeSkill([], all)).toEqual(["build"]);
  });

  test("keeps exactly one mode skill, moved to the front", () => {
    expect(ensureModeSkill(["custom", "talk", "build"], all)).toEqual(["talk", "custom"]);
  });

  test("drops a mode skill that is no longer available and re-primaries", () => {
    expect(ensureModeSkill(["learning", "custom"], ["build", "talk"])).toEqual(["build", "custom"]);
  });

  test("with no mode skill in existence, additionals stand alone", () => {
    expect(ensureModeSkill(["build", "custom"], [])).toEqual(["custom"]);
    expect(ensureModeSkill(["custom"], [])).toEqual(["custom"]);
  });
});

describe("deriveSessionMode (frontend-derived wire mode)", () => {
  const modes: Record<string, string> = { build: "agentic", talk: "talk", legacy: "build", plain: "" };
  const modeOf = (n: string) => modes[n];

  test("comes from the lowest-priority (first) selected skill", () => {
    expect(deriveSessionMode(["build", "talk"], modeOf)).toBe("agentic");
    expect(deriveSessionMode(["talk", "build"], modeOf)).toBe("talk");
    // No mode skills around: the first additional skill decides.
    expect(deriveSessionMode(["legacy"], modeOf)).toBe("agentic");
  });

  test("missing mode or empty selection falls back to talk", () => {
    expect(deriveSessionMode(["plain"], modeOf)).toBe("talk");
    expect(deriveSessionMode(["unknown"], modeOf)).toBe("talk");
    expect(deriveSessionMode([], modeOf)).toBe("talk");
  });
});

describe("usableDiffers (omit the key when it equals the original)", () => {
  test("inherit/unset never differs", () => {
    expect(usableDiffers(undefined, "ask")).toBe(false);
    expect(usableDiffers("", "deny")).toBe(false);
    expect(usableDiffers("inherit", "ask")).toBe(false);
  });

  test("equal to the original is omitted, different rides the wire", () => {
    expect(usableDiffers("ask", "ask")).toBe(false);
    expect(usableDiffers("deny", "ask")).toBe(true);
    expect(usableDiffers("yolo", undefined)).toBe(true);
    expect(usableDiffers("yolo", "yolo")).toBe(false);
  });

  test("a file without the usable key has deny as its original (not inherit)", () => {
    expect(originalUsable(undefined)).toBe("deny");
    expect(originalUsable("")).toBe("deny");
    expect(originalUsable("inherit")).toBe("deny"); // session-only value, never a file original
    expect(usableDiffers("deny", undefined)).toBe(false);
  });
});

describe("session mirror summary (list pulls)", () => {
  // The sessions collection is re-applied on every mirror refresh, session
  // selection and reconnect. The daemon summary must therefore carry the
  // skill selection and resolved approval mode; otherwise the picker resets
  // to the default primary and the permissions UI to "ask".
  test("normalizeSession keeps skills and approvalMode from the summary", () => {
    const session = normalizeSession(
      {
        id: "s1",
        cwd: "/w",
        title: "T",
        model: "m",
        status: "idle",
        createdAt: 1,
        updatedAt: 1,
        options: { effort: "medium", mode: "agentic", skills: [], access: "ask" },
        skills: {
          build: { priority: 1, active: true, usable: "" },
          notes: { priority: 2, active: true, usable: "yolo" },
          plan: { priority: 3, active: false, usable: "" },
        },
        approvalMode: "yolo",
      },
      "h1",
    );
    expect(session.skills?.notes).toEqual({ priority: 2, active: true, usable: "yolo" });
    expect(session.skills?.plan).toEqual({ priority: 3, active: false, usable: "" });
    expect(session.approvalMode).toBe("yolo");
  });
});

describe("composer execution-permission trigger (ToolbarContext)", () => {
  const src = readFileSync(
    path.join(import.meta.dir, "..", "web/src/indirect-code/components/composer/ToolbarContext.tsx"),
    "utf8",
  );

  test("desktop trigger and mobile summary show borderless short Full/Ask labels without status dots while menu and aria-label keep full descriptions", () => {
    expect(src).toContain('aria-label={`Agent permissions: ${c.yoloMode() ? "Full access" : "Ask for approval"}`}');
    expect(src).toContain(
      'class={`h-7 shrink-0 flex items-center gap-1.5 rounded-lg px-2 text-xs font-medium cursor-pointer transition-colors hover:bg-surface-muted ${c.yoloMode() ? "text-warning" : "text-fg-secondary hover:text-fg"}`}',
    );
    expect(src).toContain('<span class="hidden @[420px]:inline">{c.yoloMode() ? "Full" : "Ask"}</span>');
    expect(src).toContain('<span>{c.yoloMode() ? "Full" : "Ask"}</span>');
    expect(src).not.toContain("h-1.5 w-1.5 rounded-full bg-warning");
    expect(src).toContain('label: "Ask for approval"');
    expect(src).toContain('label: "Full access"');
  });
});
