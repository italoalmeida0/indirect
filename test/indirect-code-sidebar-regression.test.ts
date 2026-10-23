import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { createProjects } from "../web/src/indirect-code/hooks/useProjects";
import type { SessionSummary } from "../web/src/indirect-code/types";

describe("Sidebar and Multi-Project Bug Fixes Regression", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf-8");

  describe("BUG-T3-01 & BUG-T3-02: SessionSidebar inline rename and edit button", () => {
    test("SessionSidebar input has onBlur handler", () => {
      const src = read("web/src/indirect-code/components/SessionSidebar.tsx");
      expect(src).toMatch(/onBlur=\{[\s\S]*?submitRename/);
    });

    test("SessionSidebar has pencil/rename action button", () => {
      const src = read("web/src/indirect-code/components/SessionSidebar.tsx");
      expect(src).toMatch(/lucide:pencil/);
      expect(src).toMatch(/data-rc-tip="Rename"/);
      expect(src).toMatch(/setRenamingId\(s\.id\)/);
    });
  });

  describe("BUG-T3-03, BUG-T3-04 & BUG-R3-T4-06: Project row, chevron, visual highlight, and accessibility", () => {
    test("chevron toggle is an accessible button with aria-expanded", () => {
      const src = read("web/src/indirect-code/components/WorkspaceSidebar.tsx");
      expect(src).toMatch(/<button[^>]*aria-label="Toggle project"[^>]*aria-expanded=\{s\.isProjectExpanded\(p\)\}/);
      expect(src).toMatch(/toggleProjectExpanded\(p\.id\)/);
    });

    test("project row activates project on click without inverting collapse", () => {
      const src = read("web/src/indirect-code/components/WorkspaceSidebar.tsx");
      // Project row onClick should call pickProject only
      expect(src).toMatch(/onClick=\{[^}]*s\.pickProject\(p\.id\);?\s*\}/);
      // It should NOT call toggleProjectExpanded directly in the row's main onClick
      expect(src).not.toMatch(/onClick=\{[^}]*s\.pickProject\(p\.id\);?\s*s\.toggleProjectExpanded/);
    });

    test("active project has visual background highlight", () => {
      const src = read("web/src/indirect-code/components/WorkspaceSidebar.tsx");
      expect(src).toContain("bg-ink-800/60 font-medium text-ink-100 rounded-md");
    });
  });

  describe("BUG-T3-05: Bulk selection mode Select All", () => {
    test("selectAllSessions toggles between all selected and none", () => {
      const sessions: SessionSummary[] = [
        { id: "s1", hostId: "host1", cwd: "/test", title: "S1", model: "m", status: "idle", pinned: false, createdAt: 1, updatedAt: 1 },
        { id: "s2", hostId: "host1", cwd: "/test", title: "S2", model: "m", status: "idle", pinned: false, createdAt: 2, updatedAt: 2 },
      ];
      const p = createProjects({
        send: () => {},
        isOpen: () => true,
        getHostId: () => "host1",
        sessions: () => sessions,
        projects: () => [],
        toast: () => {},
        showConfirm: async () => true,
        isHostOnline: () => true,
      });

      expect(p.selectedSessions().size).toBe(0);
      p.selectAllSessions();
      expect(p.selectedSessions().size).toBe(2);
      expect(p.selectedSessions().has("s1")).toBe(true);
      expect(p.selectedSessions().has("s2")).toBe(true);

      // Toggling when all are selected should deselect all
      p.selectAllSessions();
      expect(p.selectedSessions().size).toBe(0);
    });

    test("WorkspaceSidebar renders Select All / Deselect All button", () => {
      const src = read("web/src/indirect-code/components/WorkspaceSidebar.tsx");
      expect(src).toMatch(/s\.selectAllSessions\(\)/);
      expect(src).toContain("Select All");
      expect(src).toContain("Deselect All");
    });
  });

  describe("BUG-T3-06: Bulk action bar renders even when 0 selected", () => {
    test("batch bar is shown in selection mode with disabled state when empty", () => {
      const src = read("web/src/indirect-code/components/WorkspaceSidebar.tsx");
      // Should NOT require size > 0 to show batch bar container
      expect(src).not.toContain("<Show when={s.selectionMode() && s.selectedSessions().size > 0}>");
      expect(src).toContain("<Show when={s.selectionMode()}>");
      expect(src).toContain("Select conversations to delete");
      expect(src).toMatch(/disabled=\{s\.selectedSessions\(\)\.size === 0\}/);
    });
  });

  describe("BUG-R3-T4-04: Focus restoration after closing New Project Modal", () => {
    test("focuses newProjBtn before opening modal and on modal close", () => {
      const sidebarSrc = read("web/src/indirect-code/components/WorkspaceSidebar.tsx");
      expect(sidebarSrc).toMatch(/s\.newProjBtn\?\.focus\(\);?\s*s\.setNewProjectMenuOpen\(false\);?\s*s\.openNewProjectModal\(\)/);

      const modalSrc = read("web/src/indirect-code/modals/NewProjectModal.tsx");
      expect(modalSrc).toMatch(/s\.newProjBtn\?\.focus\(\)/);
    });
  });
});
