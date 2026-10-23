import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { createProjects } from "../web/src/indirect-code/hooks/useProjects";
import type { SessionSummary } from "../web/src/indirect-code/types";

describe("Conversation History & Global Search Regression (B2-2)", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf-8");

  describe("BUG-T3-09: Filter tabs 'All', 'Pinned', 'Recent', 'Talk' in Conversation History", () => {
    test("HistoryView renders Segmented control with All, Pinned, Recent, Talk tabs", () => {
      const src = read("web/src/indirect-code/components/HistoryView.tsx");
      expect(src).toMatch(/Segmented/);
      expect(src).toMatch(/value:\s*"all",\s*label:\s*"All"/);
      expect(src).toMatch(/value:\s*"pinned",\s*label:\s*"Pinned"/);
      expect(src).toMatch(/value:\s*"recent",\s*label:\s*"Recent"/);
      expect(src).toMatch(/value:\s*"talk",\s*label:\s*"Talk"/);
    });

    test("HistoryView handles filtering for pinned, talk, and sorting for recent", () => {
      const src = read("web/src/indirect-code/components/HistoryView.tsx");
      expect(src).toMatch(/tab === "pinned"/);
      expect(src).toMatch(/s\.pinned/);
      expect(src).toMatch(/tab === "talk"/);
      expect(src).toMatch(/tab === "recent"/);
      expect(src).toMatch(/\(b\.updatedAt \?\? 0\) - \(a\.updatedAt \?\? 0\)/);
    });
  });

  describe("BUG-T3-07: Search query matches highlighted in HistoryView", () => {
    test("HistoryView defines highlightMatch and wraps matches in mark element", () => {
      const src = read("web/src/indirect-code/components/HistoryView.tsx");
      expect(src).toMatch(/function highlightMatch/);
      expect(src).toMatch(/<mark class="bg-accent-500\/30 text-ink-100 rounded px-0\.5 font-medium">/);
    });

    test("HistoryView applies highlightMatch to title, snippet, and cwd", () => {
      const src = read("web/src/indirect-code/components/HistoryView.tsx");
      expect(src).toMatch(/highlightMatch\(r\.title,\s*props\.sessionFilter\(\)\)/);
      expect(src).toMatch(/highlightMatch\(r\.snippet,\s*props\.sessionFilter\(\)\)/);
      expect(src).toMatch(/highlightMatch\(s\.title,\s*props\.sessionFilter\(\)\)/);
      expect(src).toMatch(/highlightMatch\(s\.cwd,\s*props\.sessionFilter\(\)\)/);
    });
  });

  describe("BUG-T3-08: Clicking search hit navigates and scrolls to matching turn", () => {
    test("SearchHit interface in viewTypes.ts supports optional messageIdx", () => {
      const src = read("web/src/indirect-code/viewTypes.ts");
      expect(src).toMatch(/messageIdx\?:\s*number;/);
    });

    test("useProjects maps messageIdx in noteSearchResults", () => {
      const src = read("web/src/indirect-code/hooks/useProjects.tsx");
      expect(src).toMatch(/messageIdx:\s*typeof r\.messageIdx === "number"/);
    });

    test("HistoryView passes messageIdx to selectSession", () => {
      const src = read("web/src/indirect-code/components/HistoryView.tsx");
      expect(src).toMatch(/props\.selectSession\(r\.sessionId,\s*r\.messageIdx\)/);
    });

    test("useTranscript supports scrolling to matching turn index", () => {
      const src = read("web/src/indirect-code/hooks/useTranscript.ts");
      expect(src).toMatch(/function beginLoad\(sessionId:\s*string,\s*targetMsgIdx\?:\s*number\)/);
      expect(src).toMatch(/function scrollToMessage\(msgIdx:\s*number\)/);
    });

    test("TranscriptView marks rendered message blocks with data-raw-idx", () => {
      const src = read("web/src/indirect-code/components/TranscriptView.tsx");
      expect(src).toMatch(/data-raw-idx=\{rawIdx\(\)\}/);
    });
  });

  describe("BUG-T3-10: Empty state container with illustration and guidance in Conversation History", () => {
    test("HistoryView renders empty state with lucide:search-x and match guidance", () => {
      const src = read("web/src/indirect-code/components/HistoryView.tsx");
      expect(src).toMatch(/<Icon[^>]*name="lucide:search-x"/);
      expect(src).toMatch(/No conversations or messages match '\$\{props\.sessionFilter\(\)\.trim\(\)\}'/);
    });
  });

  describe("BUG-T3-11: History search matches cwd path with explanation badge", () => {
    test("useProjects provides matchedByCwd function", () => {
      const sessions: SessionSummary[] = [
        { id: "s1", hostId: "host1", cwd: "/home/user/myproject", title: "Chat conversation", model: "m", status: "idle", pinned: false, createdAt: 1, updatedAt: 1 },
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

      p.setSessionFilter("myproject");
      expect(p.matchedByCwd(sessions[0])).toBe(true);

      p.setSessionFilter("Chat");
      expect(p.matchedByCwd(sessions[0])).toBe(false);

      p.setSessionFilter("");
      expect(p.matchedByCwd(sessions[0])).toBe(false);
    });

    test("HistoryView displays Matched project folder badge when matched by cwd", () => {
      const src = read("web/src/indirect-code/components/HistoryView.tsx");
      expect(src).toMatch(/Matched project folder:/);
      expect(src).toMatch(/isCwdMatch\(s\)/);
    });
  });

  describe("BUG-R3-T4-02: Ctrl+K toggles HistoryView and restores focus", () => {
    test("IndirectCodePage toggles HistoryView on Ctrl/Cmd+K when open", () => {
      const src = read("web/src/indirect-code/IndirectCodePage.tsx");
      expect(src).toMatch(/mod && e\.key\.toLowerCase\(\) === "k"/);
      expect(src).toMatch(/setHistoryView\(\(prev\) => !prev\)/);
    });

    test("IndirectCodePage restores focus to previous active element or composer upon closing", () => {
      const src = read("web/src/indirect-code/IndirectCodePage.tsx");
      expect(src).toMatch(/previousActiveElement/);
      expect(src).toMatch(/el\.focus\(\)/);
    });
  });
});
