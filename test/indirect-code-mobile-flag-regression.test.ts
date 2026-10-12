import { describe, expect, test, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import path from "path";

// Regression: `html.mobile` (web/index.html) is the SINGLE source of truth for
// "is this a phone/tablet" — sidebar layout (IndirectCodePage), hover
// affordances (ui.tsx) and tooltips (presentation.tsx) all read the same flag.
// The detection is UA-based (Chrome's pointer flags became unreliable):
//   - iOS incl. modern iPad (reports a "Macintosh" UA since iPadOS 13 —
//     caught by maxTouchPoints > 1) and Android;
//   - touch present;
//   - phone/tablet-sized SCREEN (min(w,h) <= 768) so orientation cannot flip
//     the result — an innerWidth threshold calls an iPhone landscape (844)
//     desktop, and min(viewport) on a maximized 1366x768 window (~600px
//     innerHeight) called touch laptops mobile.
//
// This test EXECUTES the real inline script from web/index.html against
// device fingerprints — the code under test is the shipped script itself.

const html = readFileSync(path.join(import.meta.dir, "../web/index.html"), "utf-8");
const scriptMatch = html.match(/<script>\s*\/\/ Touch-device flag[\s\S]*?<\/script>/);
if (!scriptMatch) throw new Error("web/index.html: pre-paint touch flag script not found");
const scriptSource = scriptMatch[0].replace(/^<script>/, "").replace(/<\/script>$/, "");

type Device = {
  name: string;
  ua: string;
  touch: boolean;
  screen: { width: number; height: number };
  expectMobile: boolean;
  note?: string;
};

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"; // modern iPad
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DEVICES: Device[] = [
  { name: "iPhone portrait", ua: IPHONE_UA, touch: true, screen: { width: 390, height: 844 }, expectMobile: true },
  { name: "iPhone landscape", ua: IPHONE_UA, touch: true, screen: { width: 844, height: 390 }, expectMobile: true, note: "innerWidth=844 would be desktop" },
  { name: "Android phone landscape", ua: ANDROID_UA, touch: true, screen: { width: 915, height: 412 }, expectMobile: true },
  { name: "iPad modern (Macintosh UA, maxTouchPoints 5)", ua: IPAD_UA, touch: true, screen: { width: 1024, height: 768 }, expectMobile: true, note: "real iPad reports >1 touch points" },
  { name: "iPad 10.9/Air (min=820)", ua: IPAD_UA, touch: true, screen: { width: 820, height: 1180 }, expectMobile: false, note: "documented trade-off: 768 threshold keeps big tablets on desktop layout" },
  { name: "Windows touch laptop 1366x768", ua: WIN_UA, touch: true, screen: { width: 1366, height: 768 }, expectMobile: false, note: "the regression" },
  { name: "Windows touch laptop big", ua: WIN_UA, touch: true, screen: { width: 2560, height: 1440 }, expectMobile: false },
  { name: "macOS desktop", ua: MAC_UA, touch: false, screen: { width: 1920, height: 1080 }, expectMobile: false },
  { name: "desktop small window", ua: MAC_UA, touch: false, screen: { width: 700, height: 500 }, expectMobile: false },
];

// Persistent stub: the script writes the class, consumers read it.
const classes = new Set<string>();
let device: Device = DEVICES[0];

beforeAll(() => {
  const root = globalThis as Record<string, unknown>;
  const matchMedia = () => ({ matches: false }); // pointer flags are not used anymore
  root.window = {
    get screen() {
      return { width: device.screen.width, height: device.screen.height };
    },
    matchMedia,
    addEventListener: () => {},
  };
  root.navigator = {
    get userAgent() { return device.ua; },
    get maxTouchPoints() { return device.touch ? (device.ua.includes("Macintosh") ? 5 : 1) : 0; },
  };
  root.matchMedia = matchMedia;
  root.document = {
    documentElement: {
      classList: {
        contains: (c: string) => classes.has(c),
        toggle: (c: string, v: boolean) => {
          if (v) classes.add(c);
          else classes.delete(c);
        },
      },
    },
  };
});

function runFlag(d: Device): boolean {
  device = d;
  classes.clear();
  eval(scriptSource);
  return classes.has("mobile");
}

describe("html.mobile — real script from web/index.html (UA + touch + screen)", () => {
  for (const d of DEVICES) {
    test(`${d.name} -> ${d.expectMobile ? "mobile" : "desktop"}${d.note ? ` (${d.note})` : ""}`, () => {
      expect(runFlag(d)).toBe(d.expectMobile);
    });
  }

  test("flag is the single source: layout predicate reads the same class", () => {
    // IndirectCodePage's isMobile, ui.tsx and presentation.tsx all read
    // documentElement.classList.contains("mobile") — never window width.
    runFlag(DEVICES[4]); // Windows touch laptop: desktop
    expect(classes.has("mobile")).toBe(false);
    runFlag(DEVICES[0]); // iPhone: mobile
    expect(classes.has("mobile")).toBe(true);
  });
});
