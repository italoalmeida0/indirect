import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
  type JSX,
} from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { animate } from "../../../ds/motion/animate";
import { createGlide } from "../../../ds/motion/glide";
import { press } from "../../../ds/motion/press";
import { reducedMotion } from "../../../ds/motion/reduced";
import { motionTokens, tween } from "../../../ds/motion/tokens";
import { compactTokens } from "../../context";
import { useComposerCtx, useModal, useTranscriptCtx, useUI } from "../../ctx";
import { cacheHitPct, fmtUsd, usageCosts } from "../../transcript";
import {
  type BarZonesLayout,
  computeBarZones,
  computeContextMeterMath,
  computeTokenMix,
  hitTestBarZone,
  resolveContextUsed,
  type ContextSegmentId,
  type ContextZoneId,
  type UsageBreakdownInput,
} from "../../utils/contextMeter";

type Rgb = [number, number, number];

const SWEEP_DURATION_MS = 1300;
const RECEDE_DURATION_MS = 1450;
const TRACK_RADIUS = 10;
const INNER_PAD = 2;
const CONTOUR_LW = 1.35;
const SPOTLIGHT_LW = 1.5;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp(t, 0, 1);
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

function rgbaStr(rgb: Rgb, alpha: number): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamp(alpha, 0, 1).toFixed(3)})`;
}

function cellHash(col: number, row: number, seed: number): number {
  let h =
    (Math.imul(col + 11, 374761393) +
      Math.imul(row + 7, 668265263) +
      Math.imul(seed + 3, 1274126177)) |
    0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Tests whether a `cell × cell` square at `(x, y)` fits wholly inside an
 * asymmetric rounded capsule `[capX .. capX + capW] × [capY .. capY + capH]`
 * with left corner radius `leftR` and right corner radius `rightR`.
 */
function isCellInsideCapsule(
  x: number,
  y: number,
  cell: number,
  capX: number,
  capY: number,
  capW: number,
  capH: number,
  leftR: number,
  rightR: number,
  margin = 0.25,
): boolean {
  const minX = capX + margin;
  const maxX = capX + capW - margin;
  const minY = capY + margin;
  const maxY = capY + capH - margin;
  if (x < minX || y < minY || x + cell > maxX || y + cell > maxY) {
    return false;
  }
  const halfW = (maxX - minX) * 0.5;
  const halfH = (maxY - minY) * 0.5;
  const effL = Math.max(0, Math.min(leftR - margin, halfW, halfH));
  const effR = Math.max(0, Math.min(rightR - margin, halfW, halfH));
  if (effL > 0 && x < minX + effL) {
    const dx = minX + effL - x;
    const dy = Math.max(0, minY + effL - y, y + cell - (maxY - effL));
    if (dx * dx + dy * dy > effL * effL) return false;
  }
  if (effR > 0 && x + cell > maxX - effR) {
    const dx = x + cell - (maxX - effR);
    const dy = Math.max(0, minY + effR - y, y + cell - (maxY - effR));
    if (dx * dx + dy * dy > effR * effR) return false;
  }
  return true;
}

function sampleCssVarRgb(
  probeCtx: CanvasRenderingContext2D,
  style: CSSStyleDeclaration,
  propName: string,
  fallback: Rgb,
): Rgb {
  const raw = style.getPropertyValue(propName).trim();
  if (!raw) return fallback;
  probeCtx.clearRect(0, 0, 1, 1);
  probeCtx.fillStyle = "rgb(0, 0, 0)";
  probeCtx.fillStyle = raw;
  probeCtx.fillRect(0, 0, 1, 1);
  const d = probeCtx.getImageData(0, 0, 1, 1).data;
  if ((d[3] ?? 0) === 0) return fallback;
  return [d[0] ?? fallback[0], d[1] ?? fallback[1], d[2] ?? fallback[2]];
}

interface MeterPalette {
  isDark: boolean;
  sky: Rgb;
  teal: Rgb;
  violet: Rgb;
  amber: Rgb;
  accent: Rgb;
  success: Rgb;
  warning: Rgb;
  danger: Rgb;
  surface: Rgb;
  muted: Rgb;
  border: Rgb;
}

function resolvePalette(probeCtx: CanvasRenderingContext2D, hostEl: Element): MeterPalette {
  const rootStyle = getComputedStyle(document.documentElement);
  const hostStyle = getComputedStyle(hostEl);
  const pick = (name: string, fallback: Rgb): Rgb => {
    const v = hostStyle.getPropertyValue(name).trim();
    return v
      ? sampleCssVarRgb(probeCtx, hostStyle, name, fallback)
      : sampleCssVarRgb(probeCtx, rootStyle, name, fallback);
  };
  const surface = pick("--surface", [32, 32, 34]);
  const surfaceLum = 0.2126 * surface[0] + 0.7152 * surface[1] + 0.0722 * surface[2];
  const isDark = surfaceLum < 128;

  return {
    isDark,
    sky: pick("--tone-sky", isDark ? [92, 186, 248] : [20, 114, 198]),
    teal: pick("--tone-teal", isDark ? [66, 208, 188] : [18, 128, 114]),
    violet: pick("--tone-violet", isDark ? [174, 146, 248] : [114, 72, 206]),
    amber: pick("--tone-amber", isDark ? [232, 172, 82] : [178, 114, 22]),
    accent: pick("--accent", isDark ? [74, 208, 190] : [22, 126, 114]),
    success: pick("--success", isDark ? [68, 214, 152] : [18, 134, 92]),
    warning: pick("--warning", isDark ? [232, 172, 82] : [178, 114, 22]),
    danger: pick("--danger", isDark ? [238, 108, 126] : [196, 48, 72]),
    surface,
    muted: pick("--text-muted", isDark ? [146, 146, 152] : [112, 112, 118]),
    border: pick("--border", isDark ? [58, 58, 62] : [226, 226, 230]),
  };
}

function segmentBaseRgb(id: ContextSegmentId, pal: MeterPalette): Rgb {
  switch (id) {
    case "input":
      return pal.sky;
    case "cache":
      return pal.teal;
    case "output":
      return pal.violet;
    case "reasoning":
      return pal.amber;
    case "context":
      return pal.accent;
  }
}

export function ContextUsageMeter(props: {
  pct: () => number | null;
  settledPctLabel: JSX.Element;
  settledHeadline: JSX.Element;
}) {
  const c = useComposerCtx();
  const t = useTranscriptCtx();
  const m = useModal();
  const ui = useUI();

  const [hoveredZone, setHoveredZone] = createSignal<ContextZoneId | null>(null);
  const [pinnedZone, setPinnedZone] = createSignal<ContextZoneId | null>(null);
  const [sweepP, setSweepP] = createSignal(reducedMotion() ? 1 : 0);
  const [isSweeping, setIsSweeping] = createSignal(false);
  const [sweepEpoch, setSweepEpoch] = createSignal(0);
  const [recedeP, setRecedeP] = createSignal(1);
  const [isReceding, setIsReceding] = createSignal(false);
  const [recedeEpoch, setRecedeEpoch] = createSignal(0);
  const [recedeFromTokens, setRecedeFromTokens] = createSignal<number | null>(null);
  const [recedeTargetTokens, setRecedeTargetTokens] = createSignal<number | null>(null);
  const [freedTokens, setFreedTokens] = createSignal(0);
  const [barWidth, setBarWidth] = createSignal(320);

  const [canvasEl, setCanvasEl] = createSignal<HTMLCanvasElement>();
  const [glideContainer, setGlideContainer] = createSignal<HTMLDivElement>();
  const [glideIndicator, setGlideIndicator] = createSignal<HTMLSpanElement>();

  let subtitleInnerEl: HTMLDivElement | undefined;
  let lastSubtitleKey = "";
  let touchStart: { id: number; x: number; y: number } | null = null;
  let lastCellPointerType = "mouse";
  let prevObservedUsed: number | null | undefined;
  let prevObservedUsage: UsageBreakdownInput | null = null;
  let recedeOriginUsage: UsageBreakdownInput | null = null;
  let lastRenderedUsed = 0;
  const cellRefs: Partial<Record<ContextZoneId, HTMLElement>> = {};

  const autoCompactPercent = createMemo(
    () => m?.daemonSettings?.()?.autoCompactPercent ?? 80,
  );

  const rawCtx = () => c.activeContext();
  const usedTokens = createMemo(() => resolveContextUsed(rawCtx()));
  const windowTokens = createMemo(() => rawCtx().window || 0);
  const isEstimated = createMemo(() => rawCtx().tokensLabel?.startsWith("~") ?? false);

  const effectiveUsed = createMemo(() => {
    const raw = usedTokens();
    if (!isReceding()) return raw;
    const from = recedeFromTokens();
    const to = recedeTargetTokens() ?? raw;
    if (from === null || to === null) return raw;
    return Math.round(lerp(from, to, recedeP()));
  });

  const math = createMemo(() =>
    computeContextMeterMath({
      used: effectiveUsed(),
      window: windowTokens(),
      autoCompactPercent: autoCompactPercent(),
    }),
  );

  const usage = () => t.activeUsage?.() ?? null;
  const mix = createMemo(() => computeTokenMix(usage()));
  const costs = createMemo(() => {
    const u = usage();
    return u ? usageCosts(u) : null;
  });
  const hitPct = createMemo(() => {
    const u = usage();
    return u ? cacheHitPct(u) : null;
  });
  const compactionCount = createMemo(() => t.sessionCompaction?.()?.count ?? 0);

  const activeZone = createMemo<ContextZoneId | null>(() => hoveredZone() ?? pinnedZone());

  const zones = createMemo(() =>
    computeBarZones({
      cssW: barWidth(),
      used: effectiveUsed(),
      window: windowTokens(),
      autoCompactPercent: autoCompactPercent(),
      usage: usage(),
      inset: INNER_PAD,
    }),
  );

  const activeGlideTarget = createMemo(() => {
    const z = activeZone();
    if (!z) return null;
    return cellRefs[z] ?? null;
  });

  createGlide({
    container: glideContainer,
    indicator: glideIndicator,
    target: activeGlideTarget,
    transition: motionTokens.spring.snappy,
  });

  const triggerReplay = () => {
    setIsReceding(false);
    setRecedeP(1);
    setFreedTokens(0);
    if (reducedMotion()) {
      setSweepP(1);
      setIsSweeping(false);
      return;
    }
    setSweepEpoch((n) => n + 1);
  };

  // Detect live context compaction drops while open and trigger receding particle dissolve.
  createEffect(() => {
    const nextUsed = usedTokens();
    const win = windowTokens();
    const curUsage = untrack(usage);

    if (prevObservedUsed === undefined) {
      prevObservedUsed = nextUsed;
      prevObservedUsage = curUsage ? { ...curUsage } : null;
      lastRenderedUsed = nextUsed ?? 0;
      return;
    }

    const prev = prevObservedUsed;
    const prevU = prevObservedUsage;
    prevObservedUsed = nextUsed;
    prevObservedUsage = curUsage ? { ...curUsage } : null;

    if (nextUsed === null || win <= 0) {
      setIsReceding(false);
      setRecedeP(1);
      setFreedTokens(0);
      lastRenderedUsed = nextUsed ?? 0;
      return;
    }

    if (prev !== null && nextUsed > prev + Math.max(200, win * 0.005)) {
      setIsReceding(false);
      setRecedeP(1);
      setFreedTokens(0);
    }

    const startFrom = untrack(isReceding) ? lastRenderedUsed : (prev ?? nextUsed);
    const dropRatio = (startFrom - nextUsed) / win;
    if (prev !== null && dropRatio > 0.05) {
      const freed = Math.max(0, Math.round(startFrom - nextUsed));
      setFreedTokens(freed);
      recedeOriginUsage = prevU ?? (curUsage ? { ...curUsage } : null);
      if (reducedMotion()) {
        setIsReceding(false);
        setRecedeP(1);
        lastRenderedUsed = nextUsed;
      } else {
        setIsSweeping(false);
        setSweepP(1);
        setRecedeFromTokens(Math.round(startFrom));
        setRecedeTargetTokens(Math.round(nextUsed));
        setRecedeP(0);
        setIsReceding(true);
        setRecedeEpoch((n) => n + 1);
      }
    } else if (!untrack(isReceding)) {
      lastRenderedUsed = nextUsed;
    }
  });

  // Every mount inside FloatMenu (open false -> true) starts a fresh sweep.
  createEffect(() => {
    sweepEpoch();
    if (reducedMotion()) {
      setSweepP(1);
      setIsSweeping(false);
      return;
    }
    const used = untrack(usedTokens);
    const win = untrack(windowTokens);
    if (used === null || used <= 0 || win <= 0) {
      setSweepP(1);
      setIsSweeping(false);
      return;
    }
    setSweepP(0);
    setIsSweeping(true);
  });

  // Canvas shader & RAF loop
  createEffect(() => {
    const canvas = canvasEl();
    const reduced = reducedMotion();
    const epoch = sweepEpoch();
    void epoch;
    if (!canvas || typeof document === "undefined" || typeof window === "undefined") return;

    const ctx = canvas.getContext("2d");
    const probeCtx = document
      .createElement("canvas")
      .getContext("2d", { willReadFrequently: true });
    if (!ctx || !probeCtx) return;

    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    let palette = resolvePalette(probeCtx, canvas);
    let rafId = 0;
    let sweepStartMs: number | null = null;
    let seenRecedeEpoch = untrack(recedeEpoch);
    let recedeStartMs: number | null = null;
    let recedeStartLayout: BarZonesLayout | null = null;
    let lastFrameMs = performance.now();

    const weights: Record<ContextSegmentId, number> = {
      input: 1,
      cache: 1,
      output: 1,
      reasoning: 1,
      context: 1,
    };
    const highlights: Record<ContextSegmentId, number> = {
      input: 0,
      cache: 0,
      output: 0,
      reasoning: 0,
      context: 0,
    };
    let usableGlow = 0;
    let reserveGlow = 0;

    // Exact 1:1 physical pixel backing store (`cssW * dpr === canvas.width`)
    const syncSize = () =>
      untrack(() => {
        const rect = canvas.getBoundingClientRect();
        const nextDpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
        const nextPhysW = Math.max(1, Math.round(rect.width * nextDpr));
        const nextPhysH = Math.max(1, Math.round(rect.height * nextDpr));
        const nextW = nextPhysW / nextDpr;
        const nextH = nextPhysH / nextDpr;
        if (nextW > 0 && Math.abs(nextW - barWidth()) > 0.01) {
          setBarWidth(nextW);
        }
        if (canvas.width === nextPhysW && canvas.height === nextPhysH && nextDpr === dpr) {
          cssW = nextW;
          cssH = nextH;
          return;
        }
        cssW = nextW;
        cssH = nextH;
        dpr = nextDpr;
        canvas.width = nextPhysW;
        canvas.height = nextPhysH;
      });

    const resolveSegRgb = (
      id: ContextSegmentId,
      usedRatio: number,
      isArmed: boolean,
    ): Rgb => {
      if (id === "context" && usedRatio >= 0.92) return palette.danger;
      if (id === "context" && isArmed) return palette.warning;
      return segmentBaseRgb(id, palette);
    };

    const drawFrame = (nowMs: number, isStatic: boolean) =>
      untrack(() => {
        syncSize();
        if (cssW <= 4 || cssH <= 4) return;

        const dt = clamp((nowMs - lastFrameMs) * 0.001, 0, 0.08);
        lastFrameMs = nowMs;

        const rawUsed = usedTokens();
        const win = windowTokens();

        const curRecEpoch = recedeEpoch();
        if (curRecEpoch !== seenRecedeEpoch) {
          seenRecedeEpoch = curRecEpoch;
          recedeStartMs = nowMs;
          const fromTok = recedeFromTokens() ?? rawUsed ?? 0;
          recedeStartLayout = computeBarZones({
            cssW,
            used: fromTok,
            window: win,
            autoCompactPercent: autoCompactPercent(),
            usage: recedeOriginUsage ?? usage(),
            inset: INNER_PAD,
          });
        }

        let rTime = 1;
        let used = rawUsed;

        if (!isStatic && isReceding() && rawUsed !== null && win > 0) {
          if (recedeStartMs === null) recedeStartMs = nowMs;
          rTime = clamp((nowMs - recedeStartMs) / RECEDE_DURATION_MS, 0, 1);
          const curRecedeP = rTime >= 1 ? 1 : 1 - Math.pow(1 - rTime, 2.55);
          const fromTok = recedeFromTokens() ?? rawUsed;
          const toTok = recedeTargetTokens() ?? rawUsed;
          used = Math.round(lerp(fromTok, toTok, curRecedeP));
          lastRenderedUsed = used;
          if (Math.abs(curRecedeP - recedeP()) > 0.003 || rTime >= 1) {
            setRecedeP(curRecedeP);
          }
          if (rTime >= 1) {
            setIsReceding(false);
          }
        } else {
          recedeStartMs = null;
          if (rawUsed !== null) lastRenderedUsed = rawUsed;
        }

        const hasSweepableFill =
          !isStatic && !isReceding() && used !== null && used > 0 && win > 0;

        let uTime = 1;
        let curSweepP = 1;
        if (hasSweepableFill) {
          if (sweepStartMs === null) sweepStartMs = nowMs;
          uTime = clamp((nowMs - sweepStartMs) / SWEEP_DURATION_MS, 0, 1);
          curSweepP = uTime >= 1 ? 1 : 1 - Math.pow(1 - uTime, 2.25);
          if (Math.abs(curSweepP - sweepP()) > 0.004 || uTime >= 1) {
            setSweepP(curSweepP);
          }
          if (uTime >= 1 && isSweeping()) {
            setIsSweeping(false);
          }
        } else {
          if (sweepP() !== 1) setSweepP(1);
          if (isSweeping()) setIsSweeping(false);
        }

        const zLayout = computeBarZones({
          cssW,
          used,
          window: win,
          autoCompactPercent: autoCompactPercent(),
          usage: usage(),
          inset: INNER_PAD,
        });
        const currentMath = computeContextMeterMath({
          used,
          window: win,
          autoCompactPercent: autoCompactPercent(),
        });
        const focusZone = activeZone();
        const kLerp = isStatic ? 1 : 1 - Math.exp(-dt * 18);

        const segIds: ContextSegmentId[] = ["input", "cache", "output", "reasoning", "context"];
        const segSpotlighted =
          focusZone !== null && focusZone !== "usable" && focusZone !== "reserve";

        for (const id of segIds) {
          const targetW =
            focusZone === null
              ? 1
              : focusZone === id
                ? 1.15
                : segSpotlighted
                  ? 0.28
                  : 0.44;
          const targetH = focusZone === id ? 1 : 0;
          weights[id] = lerp(weights[id], targetW, kLerp);
          highlights[id] = lerp(highlights[id], targetH, kLerp);
        }
        usableGlow = lerp(usableGlow, focusZone === "usable" ? 1 : 0, kLerp);
        reserveGlow = lerp(reserveGlow, focusZone === "reserve" ? 1 : 0, kLerp);

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const isDark = palette.isDark;
        const innerLeft = zLayout.innerLeft;
        const innerRight = zLayout.innerRight;
        const innerW = zLayout.innerW;
        const topY = INNER_PAD;
        const botY = cssH - INNER_PAD;
        const innerH = Math.max(0, botY - topY);
        const endOuterR = TRACK_RADIUS - INNER_PAD; // 8.0px concentric outer cap
        const tSec = isStatic ? 1.85 : nowMs * 0.001;

        const frontierX = innerLeft + zLayout.totalOccupiedW * curSweepP;
        const env =
          uTime >= 0.999
            ? 0
            : Math.sin(Math.min(1, uTime / 0.09) * Math.PI * 0.5) *
              (1 - Math.pow(Math.max(0, (uTime - 0.72) / 0.28), 2));
        const rEnv =
          rTime >= 0.998
            ? 0
            : Math.sin(Math.min(1, rTime / 0.07) * Math.PI * 0.5) *
              (1 - Math.pow(Math.max(0, (rTime - 0.76) / 0.24), 1.8));

        // ---------------------------------------------------------------------
        // Pass 0: Recessed outer pocket & uniform 4-sided 1px outer hairline
        // ---------------------------------------------------------------------
        const pocketFill = isDark
          ? lerpRgb(palette.surface, [0, 0, 0], 0.44)
          : lerpRgb(palette.surface, palette.border, 0.34);
        const outerBorderRgb = isDark
          ? lerpRgb(palette.surface, palette.muted, 0.32)
          : lerpRgb(palette.border, palette.muted, 0.22);

        ctx.save();
        ctx.beginPath();
        ctx.roundRect(0.5, 0.5, cssW - 1, cssH - 1, TRACK_RADIUS - 0.5);
        ctx.fillStyle = `rgb(${pocketFill[0]}, ${pocketFill[1]}, ${pocketFill[2]})`;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgbaStr(outerBorderRgb, isDark ? 0.88 : 0.92);
        ctx.stroke();
        ctx.restore();

        // ---------------------------------------------------------------------
        // Pass 1: Unified inner track subtle zone washes (NO separate pill boxes at rest)
        // ---------------------------------------------------------------------
        if (innerW > 2 && innerH > 2) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(innerLeft, topY, innerW, innerH, endOuterR);
          ctx.clip();

          if (zLayout.thresholdX !== null && zLayout.thresholdX < innerRight) {
            const rWashAlpha =
              (isDark ? 0.048 : 0.062) + reserveGlow * (isDark ? 0.1 : 0.12);
            ctx.fillStyle = rgbaStr(palette.warning, rWashAlpha);
            ctx.fillRect(
              zLayout.thresholdX,
              topY,
              Math.max(0, innerRight - zLayout.thresholdX),
              innerH,
            );
          }

          if (usableGlow > 0.01 && zLayout.usableZone) {
            const uWashAlpha = usableGlow * (isDark ? 0.1 : 0.12);
            ctx.fillStyle = rgbaStr(palette.success, uWashAlpha);
            ctx.fillRect(
              zLayout.usableZone.x0,
              topY,
              zLayout.usableZone.width,
              innerH,
            );
          }

          ctx.restore();
        }

        // Global continuous quincunx lattice: cell = 2px, pitch = 3px, (col + row) % 2 === 0
        const cell = 2;
        const pitch = 3;
        const usableInteriorH = Math.max(2, cssH - (INNER_PAD + CONTOUR_LW) * 2);
        const usableInteriorW = Math.max(2, cssW - (INNER_PAD + CONTOUR_LW) * 2);
        const rows = Math.max(1, Math.floor((usableInteriorH + 1) / pitch));
        const cols = Math.max(1, Math.floor((usableInteriorW + 1) / pitch));
        const gridH = rows * pitch - (pitch - cell);
        const gridW = cols * pitch - (pitch - cell);
        const x0 = Math.round((cssW - gridW) / 2);
        const y0 = Math.round((cssH - gridH) / 2);

        // ---------------------------------------------------------------------
        // Pass 2: Unused capacity socket lattice (continuous across Usable & Reserve)
        // ---------------------------------------------------------------------
        const socketInX = innerLeft + 1;
        const socketInY = topY + 1;
        const socketInW = Math.max(0, innerW - 2);
        const socketInH = Math.max(0, innerH - 2);
        const socketInR = Math.max(1, endOuterR - 1);

        for (let col = 0; col < cols; col++) {
          const x = x0 + col * pitch;
          const cx = x + 1;
          if (zLayout.totalOccupiedW > 0 && cx <= frontierX + 1.2) continue;

          const inReserve = zLayout.thresholdX !== null && cx >= zLayout.thresholdX;

          for (let row = 0; row < rows; row++) {
            if (((col + row) & 1) !== 0) continue;
            const y = y0 + row * pitch;
            if (
              !isCellInsideCapsule(
                x,
                y,
                cell,
                socketInX,
                socketInY,
                socketInW,
                socketInH,
                socketInR,
                socketInR,
                0.2,
              )
            ) {
              continue;
            }

            let rgb: Rgb = palette.muted;
            let alpha = isDark ? 0.085 : 0.115;
            if (segSpotlighted) alpha *= 0.58;

            if (inReserve) {
              alpha = isDark ? 0.068 : 0.088;
              if (segSpotlighted) alpha *= 0.6;
              rgb = lerpRgb(palette.muted, palette.warning, 0.36 + reserveGlow * 0.64);
              if (reserveGlow > 0.01) {
                const rWave = 0.5 + 0.5 * Math.sin(tSec * 2.2 - col * 0.22 - row * 0.35);
                alpha = lerp(alpha, (isDark ? 0.24 : 0.3) + 0.42 * rWave, reserveGlow);
              }
            } else if (win > 0 && usableGlow > 0.01) {
              const uWave = 0.5 + 0.5 * Math.sin(tSec * 2.4 - col * 0.22 + row * 0.35);
              rgb = lerpRgb(palette.muted, palette.success, usableGlow * 0.88);
              alpha = lerp(alpha, (isDark ? 0.24 : 0.3) + 0.42 * uWave, usableGlow);
            }

            ctx.fillStyle = rgbaStr(rgb, alpha);
            ctx.fillRect(x, y, cell, cell);
          }
        }

        // ---------------------------------------------------------------------
        // Pass 3 & 4: Unified Occupied Capsule `U` (Zero Gaps, Seamless Layer Blending,
        //             Complete Curved Left Start & Right End Contour)
        // ---------------------------------------------------------------------
        const visibleOccupiedW = Math.max(0, frontierX - innerLeft);
        const reachedSegs = zLayout.segments.filter((s) => s.x0 < frontierX - 0.5);

        if (zLayout.totalOccupiedW > 0 && visibleOccupiedW > 1.5 && reachedSegs.length > 0) {
          const touchesRightEnd = visibleOccupiedW >= innerW - 0.5;
          const rightOuterR = touchesRightEnd ? endOuterR : 4.25;
          const lw = CONTOUR_LW;

          const uInX = innerLeft + lw;
          const uInY = topY + lw;
          const uInW = Math.max(0, visibleOccupiedW - lw * 2);
          const uInH = Math.max(0, innerH - lw * 2);
          const uInLeftR = Math.max(1, endOuterR - lw);
          const uInRightR = Math.max(1, rightOuterR - lw);

          // 3a. Unified interior: blended horizontal layer wash + frontier plasma + unbroken LED lattice
          if (uInW > 0.5 && uInH > 1) {
            ctx.save();
            ctx.beginPath();
            ctx.roundRect(uInX, uInY, uInW, uInH, [
              uInLeftR,
              uInRightR,
              uInRightR,
              uInLeftR,
            ]);
            ctx.clip();

            // Smoothly blended layer wash across contiguous segments
            const washGrad = ctx.createLinearGradient(
              innerLeft,
              0,
              innerLeft + visibleOccupiedW,
              0,
            );
            const blendHalfPx = 4.5;
            for (let ri = 0; ri < reachedSegs.length; ri++) {
              const s = reachedSegs[ri]!;
              const sEnd = Math.min(s.x1, frontierX);
              const localBlend = Math.min(blendHalfPx, Math.max(0, (sEnd - s.x0) * 0.35));
              const rgb = resolveSegRgb(s.id, currentMath.usedRatio, currentMath.isArmed);
              const a = clamp(
                (isDark ? 0.105 : 0.138) * weights[s.id] + highlights[s.id] * 0.065,
                0,
                0.45,
              );
              const startOff =
                ri === 0
                  ? 0
                  : clamp((s.x0 + localBlend - innerLeft) / visibleOccupiedW, 0, 1);
              const endOff =
                ri === reachedSegs.length - 1
                  ? 1
                  : clamp((sEnd - localBlend - innerLeft) / visibleOccupiedW, startOff, 1);
              washGrad.addColorStop(startOff, rgbaStr(rgb, a));
              if (endOff > startOff) {
                washGrad.addColorStop(endOff, rgbaStr(rgb, a));
              }
            }
            ctx.fillStyle = washGrad;
            ctx.fillRect(uInX, uInY, uInW, uInH);

            // Frontier incandescent bloom & Light-mode jewel plasma backdrop
            const leadSeg = reachedSegs[reachedSegs.length - 1]!;
            const leadRgb = resolveSegRgb(
              leadSeg.id,
              currentMath.usedRatio,
              currentMath.isArmed,
            );
            const leadHotRgb = lerpRgb(leadRgb, [255, 255, 255], isDark ? 0.86 : 0.62);

            if (env > 0.01) {
              if (!isDark) {
                const plasmaStart = Math.max(uInX, frontierX - 30);
                const plasmaGrad = ctx.createLinearGradient(
                  plasmaStart,
                  0,
                  frontierX + 2,
                  0,
                );
                plasmaGrad.addColorStop(0, rgbaStr(leadRgb, 0));
                plasmaGrad.addColorStop(1, rgbaStr(leadRgb, 0.3 * env));
                ctx.fillStyle = plasmaGrad;
                ctx.fillRect(plasmaStart, uInY, Math.max(0, frontierX - plasmaStart + 2), uInH);
              }

              const gx = frontierX - 3.5;
              const gy = cssH * 0.5;
              const bloom = ctx.createRadialGradient(gx, gy, 1.5, gx, gy, 28);
              bloom.addColorStop(0, rgbaStr(leadHotRgb, (isDark ? 0.34 : 0.25) * env));
              bloom.addColorStop(0.45, rgbaStr(leadRgb, 0.14 * env));
              bloom.addColorStop(1, rgbaStr(leadRgb, 0));
              ctx.fillStyle = bloom;
              ctx.fillRect(Math.max(uInX, gx - 30), uInY, 60, uInH);
            }

            // Continuous unbroken quincunx LED matrix across all reached segments
            for (let col = 0; col < cols; col++) {
              const x = x0 + col * pitch;
              const cx = x + 1;
              if (x < uInX || cx > frontierX + 1.5) continue;

              // Resolve primary segment + seamless ±3px color cross-blend at interior boundaries
              let segIdx = 0;
              for (let si = 0; si < reachedSegs.length; si++) {
                const cand = reachedSegs[si]!;
                if (cx >= cand.x0 && (cx <= cand.x1 || si === reachedSegs.length - 1)) {
                  segIdx = si;
                  break;
                }
              }
              const seg = reachedSegs[segIdx]!;
              let baseRgb = resolveSegRgb(
                seg.id,
                currentMath.usedRatio,
                currentMath.isArmed,
              );
              let w = weights[seg.id];

              if (!segSpotlighted && reachedSegs.length > 1) {
                const seamBlendR = 3.2;
                if (segIdx > 0 && cx - seg.x0 < seamBlendR) {
                  const prevSeg = reachedSegs[segIdx - 1]!;
                  const prevRgb = resolveSegRgb(
                    prevSeg.id,
                    currentMath.usedRatio,
                    currentMath.isArmed,
                  );
                  const blendT = 0.5 + ((cx - seg.x0) / seamBlendR) * 0.5;
                  baseRgb = lerpRgb(prevRgb, baseRgb, blendT);
                  w = lerp(weights[prevSeg.id], w, blendT);
                } else if (segIdx < reachedSegs.length - 1 && seg.x1 - cx < seamBlendR) {
                  const nextSeg = reachedSegs[segIdx + 1]!;
                  const nextRgb = resolveSegRgb(
                    nextSeg.id,
                    currentMath.usedRatio,
                    currentMath.isArmed,
                  );
                  const blendT = 0.5 - ((seg.x1 - cx) / seamBlendR) * 0.5;
                  baseRgb = lerpRgb(baseRgb, nextRgb, blendT);
                  w = lerp(w, weights[nextSeg.id], blendT);
                }
              }

              const hotRgb = lerpRgb(baseRgb, [255, 255, 255], isDark ? 0.86 : 0.62);
              const d = frontierX - cx;

              for (let row = 0; row < rows; row++) {
                const y = y0 + row * pitch;
                if (
                  !isCellInsideCapsule(
                    x,
                    y,
                    cell,
                    uInX,
                    uInY,
                    uInW,
                    uInH,
                    uInLeftR,
                    uInRightR,
                    0.2,
                  )
                ) {
                  continue;
                }

                const rowJitter = (cellHash(0, row, 9) - 0.5) * 4;
                const dJ = d + rowJitter * env;
                const leadMask = clamp((d + 1.5) / 2.5, 0, 1);
                if (leadMask <= 0.01) continue;

                const crest =
                  env > 0.001
                    ? env * leadMask * Math.exp(-Math.pow(Math.max(0, dJ - 3) / 15.5, 1.7))
                    : 0;

                const isEven = ((col + row) & 1) === 0;
                const phase = cellHash(col, row, 2) * Math.PI * 2;
                const speed = 1.35 + cellHash(col, row, 3) * 1.9;
                const twinkle = 0.5 + 0.5 * Math.sin(tSec * speed + phase);
                const wave =
                  0.5 +
                  0.5 *
                    Math.sin(
                      tSec * 1.8 - col * 0.19 + Math.sin(row * 0.85) * 0.55 + phase * 0.3,
                    );
                const spark = 0.46 * twinkle + 0.54 * wave;

                const baseFloor = isDark ? 0.18 : 0.25;
                const waveAmp = 0.76;
                const ambientAlpha = isEven
                  ? baseFloor +
                    (cellHash(col, row, 1) < 0.7
                      ? waveAmp * Math.pow(spark, 1.5)
                      : 0.09 * spark)
                  : 0;

                const oddFillAlpha = !isEven
                  ? Math.pow(crest, 1.4) * (0.48 + 0.52 * spark)
                  : 0;

                let rawAlpha = Math.max(ambientAlpha * w, crest * 0.98, oddFillAlpha);
                if (!isDark && crest > 0.15 && crest <= 0.65) {
                  rawAlpha = Math.max(rawAlpha, Math.min(1, crest * 1.35));
                }
                const finalAlpha = clamp(rawAlpha * leadMask, 0, 1);
                if (finalAlpha < 0.03) continue;

                const glintMix =
                  isEven && spark > 0.89 && cellHash(col, row, 5) > 0.52
                    ? isDark
                      ? 0.68
                      : 0.42
                    : 0;

                let hotMix: number;
                if (isDark) {
                  hotMix = Math.max(
                    glintMix * Math.min(1, w),
                    Math.pow(crest, 0.72) * 0.92,
                  );
                } else {
                  const crestHot = crest > 0.62 ? ((crest - 0.62) / 0.38) * 0.95 : 0;
                  hotMix = Math.max(glintMix * Math.min(1, w), crestHot);
                }

                const dotRgb = lerpRgb(baseRgb, hotRgb, hotMix);
                ctx.fillStyle = rgbaStr(dotRgb, finalAlpha);
                ctx.fillRect(x, y, cell, cell);
              }
            }

            // Whisper-soft interior glass seam hairlines (no gaps, preserves unified flow)
            for (let ri = 0; ri < reachedSegs.length - 1; ri++) {
              const seamSeg = reachedSegs[ri]!;
              const nextSeg = reachedSegs[ri + 1]!;
              if (seamSeg.x1 >= frontierX - 0.5) continue;
              const seamRgb = lerpRgb(
                resolveSegRgb(seamSeg.id, currentMath.usedRatio, currentMath.isArmed),
                resolveSegRgb(nextSeg.id, currentMath.usedRatio, currentMath.isArmed),
                0.5,
              );
              const seamW = Math.max(weights[seamSeg.id], weights[nextSeg.id]);
              ctx.fillStyle = rgbaStr(seamRgb, clamp(0.22 * seamW, 0.06, 0.4));
              ctx.fillRect(Math.round(seamSeg.x1) - 0.5, uInY, 1, uInH);
            }

            ctx.restore();
          }

          // 3b. ONE Unified Multi-Color `roundRect` Contour Stroke for `U`
          //     - Complete curved left arc (Input)
          //     - Seamless unbroken top & bottom rims with smooth color-blend across seams
          //     - Complete curved right cap (Reasoning / frontier / symmetric 100% full right arc)
          const uX = innerLeft + lw * 0.5;
          const uY = topY + lw * 0.5;
          const uW = Math.max(1, visibleOccupiedW - lw);
          const uH = Math.max(1, innerH - lw);
          const cLeftR = Math.max(1, endOuterR - lw * 0.5); // 7.325px concentric with (10,10)
          const cRightR = Math.max(1.25, rightOuterR - lw * 0.5);

          const contourGrad = ctx.createLinearGradient(
            innerLeft,
            0,
            innerLeft + visibleOccupiedW,
            0,
          );
          const rimBlendHalfPx = 3.5;
          for (let ri = 0; ri < reachedSegs.length; ri++) {
            const s = reachedSegs[ri]!;
            const sEnd = Math.min(s.x1, frontierX);
            const localRimBlend = Math.min(rimBlendHalfPx, Math.max(0, (sEnd - s.x0) * 0.35));
            const rawRgb = resolveSegRgb(s.id, currentMath.usedRatio, currentMath.isArmed);
            const rimRgb = lerpRgb(rawRgb, [255, 255, 255], isDark ? 0.14 : 0.02);
            const rimAlpha = clamp((isDark ? 0.8 : 0.84) * Math.min(1, weights[s.id]), 0.18, 0.96);

            const startOff =
              ri === 0
                ? 0
                : clamp((s.x0 + localRimBlend - innerLeft) / visibleOccupiedW, 0, 1);
            const isLast = ri === reachedSegs.length - 1;
            const edgeGlow = Math.max(env, rEnv * 0.85);
            const endOff = isLast
              ? edgeGlow > 0.01 && visibleOccupiedW > 12
                ? clamp((visibleOccupiedW - 7) / visibleOccupiedW, startOff, 0.98)
                : 1
              : clamp((sEnd - localRimBlend - innerLeft) / visibleOccupiedW, startOff, 1);

            contourGrad.addColorStop(startOff, rgbaStr(rimRgb, rimAlpha));
            if (endOff > startOff) {
              contourGrad.addColorStop(endOff, rgbaStr(rimRgb, rimAlpha));
            }
            if (isLast && edgeGlow > 0.01 && visibleOccupiedW > 12) {
              const hotRim = lerpRgb(rawRgb, [255, 255, 255], isDark ? 0.86 : 0.62);
              contourGrad.addColorStop(
                1,
                rgbaStr(hotRim, clamp(0.95 * edgeGlow + rimAlpha * (1 - edgeGlow), 0.4, 0.98)),
              );
            }
          }

          ctx.save();
          ctx.strokeStyle = contourGrad;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.roundRect(uX, uY, uW, uH, [cLeftR, cRightR, cRightR, cLeftR]);
          ctx.stroke();
          ctx.restore();

          // 3c. Spotlight Highlight Frame ONLY on the actively hovered/pinned segment
          for (let si = 0; si < reachedSegs.length; si++) {
            const seg = reachedSegs[si]!;
            const hl = highlights[seg.id];
            if (hl <= 0.02) continue;
            const segEnd = Math.min(seg.x1, frontierX);
            const segVisW = segEnd - seg.x0;
            if (segVisW < 3) continue;

            const rawRgb = resolveSegRgb(seg.id, currentMath.usedRatio, currentMath.isArmed);
            const spotRgb = lerpRgb(rawRgb, [255, 255, 255], isDark ? 0.3 : 0.08);
            const sLw = SPOTLIGHT_LW;
            const spotLeftR = si === 0 ? Math.max(1, endOuterR - sLw * 0.5) : 2.5;
            const spotRightR =
              si === reachedSegs.length - 1 && touchesRightEnd
                ? Math.max(1, endOuterR - sLw * 0.5)
                : si === reachedSegs.length - 1
                  ? Math.max(1.25, rightOuterR - sLw * 0.5)
                  : 2.5;

            ctx.save();
            ctx.beginPath();
            ctx.roundRect(innerLeft, topY, visibleOccupiedW, innerH, [
              endOuterR,
              rightOuterR,
              rightOuterR,
              endOuterR,
            ]);
            ctx.clip();

            ctx.strokeStyle = rgbaStr(spotRgb, 0.95 * hl);
            ctx.lineWidth = sLw;
            ctx.beginPath();
            ctx.roundRect(
              seg.x0 + sLw * 0.5,
              topY + sLw * 0.5,
              Math.max(1, segVisW - sLw),
              Math.max(1, innerH - sLw),
              [spotLeftR, spotRightR, spotRightR, spotLeftR],
            );
            ctx.stroke();
            ctx.restore();
          }
        }

        // ---------------------------------------------------------------------
        // Pass 4b: Compaction Receding Particle Dissolve (2x2 colored pixel sparks
        //          evaporating off the shrinking right cap into a ~38px wake)
        // ---------------------------------------------------------------------
        if (rEnv > 0.01 && innerW > 6 && innerH > 6) {
          const recedingX = frontierX;
          const originSegs =
            recedeStartLayout && recedeStartLayout.segments.length > 0
              ? recedeStartLayout.segments
              : zLayout.segments;
          const originEndX = recedeStartLayout
            ? recedeStartLayout.occupiedEndX
            : innerRight;

          const resolveWakeRgb = (sampleX: number): Rgb => {
            for (let si = 0; si < originSegs.length; si++) {
              const s = originSegs[si]!;
              if (sampleX <= s.x1 || si === originSegs.length - 1) {
                return segmentBaseRgb(s.id, palette);
              }
            }
            return palette.accent;
          };

          ctx.save();
          ctx.beginPath();
          ctx.roundRect(innerLeft, topY, innerW, innerH, endOuterR);
          ctx.clip();

          // Warm sublimating glow right on the shrinking right cap
          const lipRgb = resolveWakeRgb(recedingX + 2);
          const lipHotRgb = lerpRgb(lipRgb, [255, 255, 255], isDark ? 0.78 : 0.48);
          const lipBloom = ctx.createRadialGradient(
            recedingX,
            cssH * 0.5,
            1,
            recedingX,
            cssH * 0.5,
            24,
          );
          lipBloom.addColorStop(0, rgbaStr(lipHotRgb, (isDark ? 0.26 : 0.19) * rEnv));
          lipBloom.addColorStop(0.5, rgbaStr(lipRgb, 0.1 * rEnv));
          lipBloom.addColorStop(1, rgbaStr(lipRgb, 0));
          ctx.fillStyle = lipBloom;
          ctx.fillRect(Math.max(innerLeft, recedingX - 24), topY, 50, innerH);

          const maxWakeX = Math.min(innerRight - cell, originEndX + 16, recedingX + 42);
          for (let col = 0; col < cols; col++) {
            const xBase = x0 + col * pitch;
            const cx = xBase + 1;
            if (cx < recedingX - 1.5 || xBase > maxWakeX) continue;

            const wakeDist = cx - recedingX;
            const baseWakeRgb = resolveWakeRgb(cx);

            for (let row = 0; row < rows; row++) {
              const hSpawn = cellHash(col, row, 31);
              const densityCap = wakeDist < 8 ? 0.64 : 0.46;
              if (hSpawn > densityCap) continue;

              const sparkReach =
                (10 + cellHash(col, row, 37) * 30) * (0.32 + 0.68 * rEnv);
              const age = clamp((wakeDist + 1.5) / Math.max(5, sparkReach), 0, 1);
              if (age <= 0 || age >= 1) continue;

              const driftX =
                age * (3.5 + cellHash(col, row, 41) * 14.5) +
                Math.sin(tSec * 6.5 + hSpawn * 14) * 1.1 * age;
              const vyDir = (cellHash(col, row, 43) - 0.52) * 2;
              const driftY =
                Math.pow(age, 1.32) * vyDir * 10.5 +
                Math.cos(tSec * 5.2 + cellHash(col, row, 47) * 11) * 0.9 * age;

              const sx = Math.round((xBase + driftX) * 2) * 0.5;
              const sy = Math.round((y0 + row * pitch + driftY) * 2) * 0.5;
              if (
                sx < recedingX - 1 ||
                sx + cell > innerRight - 0.5 ||
                sy < topY + 0.5 ||
                sy + cell > botY - 0.5
              ) {
                continue;
              }

              const lipHeat =
                age < 0.32 ? (1 - age / 0.32) * (isDark ? 0.78 : 0.48) : 0;
              const sparkRgb = lerpRgb(baseWakeRgb, [255, 255, 255], lipHeat);
              const sparkAlpha = clamp(
                Math.pow(1 - age, 1.38) *
                  rEnv *
                  (0.7 + 0.3 * cellHash(col, row, 53)),
                0,
                1,
              );
              if (sparkAlpha < 0.04) continue;

              ctx.fillStyle = rgbaStr(sparkRgb, sparkAlpha);
              ctx.fillRect(sx, sy, cell, cell);
            }
          }

          ctx.restore();
        }

        // ---------------------------------------------------------------------
        // Pass 5: Spotlight Frames for Usable / Reserve (ONLY on hover/pin) + 80% Reticle
        // ---------------------------------------------------------------------
        const sLw = SPOTLIGHT_LW;
        const cEndSpotR = Math.max(1, endOuterR - sLw * 0.5);

        if (usableGlow > 0.02 && zLayout.usableZone && zLayout.usableZone.width >= 4) {
          const uz = zLayout.usableZone;
          const uLeftR = zLayout.totalOccupiedW === 0 ? cEndSpotR : 2.5;
          const uRightR = zLayout.thresholdX === null ? cEndSpotR : 2.5;
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(innerLeft, topY, innerW, innerH, endOuterR);
          ctx.clip();
          ctx.strokeStyle = rgbaStr(palette.success, 0.88 * usableGlow);
          ctx.lineWidth = sLw;
          ctx.beginPath();
          ctx.roundRect(
            uz.x0 + sLw * 0.5,
            topY + sLw * 0.5,
            Math.max(1, uz.width - sLw),
            Math.max(1, innerH - sLw),
            [uLeftR, uRightR, uRightR, uLeftR],
          );
          ctx.stroke();
          ctx.restore();
        }

        if (reserveGlow > 0.02 && zLayout.reserveZone && zLayout.reserveZone.width >= 4) {
          const rz = zLayout.reserveZone;
          const rLeftR =
            zLayout.totalOccupiedW === 0 && !zLayout.usableZone ? cEndSpotR : 2.5;
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(innerLeft, topY, innerW, innerH, endOuterR);
          ctx.clip();
          ctx.strokeStyle = rgbaStr(palette.warning, 0.9 * reserveGlow);
          ctx.lineWidth = sLw;
          ctx.beginPath();
          ctx.roundRect(
            rz.x0 + sLw * 0.5,
            topY + sLw * 0.5,
            Math.max(1, rz.width - sLw),
            Math.max(1, innerH - sLw),
            [rLeftR, cEndSpotR, cEndSpotR, rLeftR],
          );
          ctx.stroke();
          ctx.restore();
        }

        if (zLayout.thresholdX !== null) {
          const tx = Math.round(zLayout.thresholdX) + 0.5;
          const nearOrArmed =
            currentMath.isArmed ||
            currentMath.usedRatio >= currentMath.thresholdRatio * 0.85 ||
            reserveGlow > 0.05 ||
            usableGlow > 0.05;
          const markerRgb = nearOrArmed
            ? palette.warning
            : lerpRgb(palette.muted, palette.warning, 0.65);
          const lineAlpha = clamp(
            (currentMath.isArmed ? 0.9 : isDark ? 0.56 : 0.64) +
              Math.max(reserveGlow, usableGlow) * 0.34,
            0,
            1,
          );
          const tickAlpha = clamp(lineAlpha + 0.22, 0, 1);

          ctx.save();
          ctx.strokeStyle = rgbaStr(markerRgb, lineAlpha);
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 2]);
          ctx.beginPath();
          ctx.moveTo(tx, topY + 3);
          ctx.lineTo(tx, botY - 3);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = rgbaStr(markerRgb, tickAlpha);
          ctx.fillRect(tx - 1.5, topY, 3, 2.2);
          ctx.fillRect(tx - 1.5, botY - 2.2, 3, 2.2);
          ctx.restore();
        }
      });

    palette = resolvePalette(probeCtx, canvas);
    syncSize();
    drawFrame(performance.now(), reduced);

    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(() => {
        syncSize();
        drawFrame(performance.now(), reduced);
      });
      ro.observe(canvas);
    }

    let mo: MutationObserver | undefined;
    if (typeof MutationObserver === "function") {
      mo = new MutationObserver(() => {
        palette = resolvePalette(probeCtx, canvas);
        drawFrame(performance.now(), reduced);
      });
      mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-accent"],
      });
    }

    if (!reduced) {
      const tick = (nowMs: number) => {
        drawFrame(nowMs, false);
        rafId = window.requestAnimationFrame(tick);
      };
      rafId = window.requestAnimationFrame(tick);
    } else {
      createEffect(() => {
        void activeZone();
        void usedTokens();
        void windowTokens();
        void autoCompactPercent();
        void usage();
        drawFrame(performance.now(), true);
      });
    }

    onCleanup(() => {
      if (rafId) window.cancelAnimationFrame(rafId);
      ro?.disconnect();
      mo?.disconnect();
    });
  });

  // Subtitle state key & 130ms blurred crossfade morph
  const subtitleStateKey = createMemo(() => {
    const z = activeZone();
    if (z) return `zone:${z}`;
    if (isSweeping() && sweepP() < 0.96 && (usedTokens() ?? 0) > 0 && windowTokens() > 0) {
      return "sweep";
    }
    if (isReceding() && recedeP() < 0.96 && windowTokens() > 0) {
      return "receding";
    }
    const cm = math();
    if (cm.window <= 0) return "idle:no-window";
    if (cm.used === null) return `idle:empty:${cm.autoCompactPercent}`;
    if (!cm.autoCompactEnabled) return freedTokens() > 0 ? "idle:freed" : "idle:off";
    if (cm.isArmed) return "idle:armed";
    return freedTokens() > 0 ? "idle:freed" : "idle:usable";
  });

  createEffect(() => {
    const key = subtitleStateKey();
    if (!subtitleInnerEl) {
      lastSubtitleKey = key;
      return;
    }
    if (lastSubtitleKey && lastSubtitleKey !== key && !reducedMotion()) {
      animate(
        subtitleInnerEl,
        { opacity: 1, translate: "0px 0px", filter: "blur(0px)" },
        tween.fast,
        {
          from: { opacity: 0, translate: "0px 2px", filter: "blur(2px)" },
          clear: ["filter", "translate"],
        },
      );
    }
    lastSubtitleKey = key;
  });

  const costSuffix = (v: number | undefined) => {
    const cObj = costs();
    return cObj ? ` · $${fmtUsd(v || 0)}` : "";
  };

  const renderSubtitleContent = (): JSX.Element => {
    const z = activeZone();
    const cm = math();
    const mx = mix();
    const hp = hitPct();

    if (z === "input") {
      return (
        <>
          <span class="h-2 w-2 rounded-[2px] bg-tone-sky shrink-0" />
          <span class="font-medium text-fg shrink-0">Input</span>
          <span class="font-mono tabular-nums text-fg-secondary shrink-0">
            {compactTokens(mx.inTok)}
          </span>
          <span class="text-fg-muted truncate">· Uncached prompt{costSuffix(costs()?.input)}</span>
        </>
      );
    }
    if (z === "cache") {
      return (
        <>
          <span class="h-2 w-2 rounded-[2px] bg-tone-teal shrink-0" />
          <span class="font-medium text-fg shrink-0">Cache</span>
          <span class="font-mono tabular-nums text-fg-secondary shrink-0">
            {compactTokens(mx.cacheTok)}
          </span>
          <span class="text-fg-muted truncate">
            · {hp !== null ? `${hp}% hit rate` : "Cached context"}
            {costSuffix(costs()?.cache)}
          </span>
        </>
      );
    }
    if (z === "output") {
      return (
        <>
          <span class="h-2 w-2 rounded-[2px] bg-tone-violet shrink-0" />
          <span class="font-medium text-fg shrink-0">Output</span>
          <span class="font-mono tabular-nums text-fg-secondary shrink-0">
            {compactTokens(mx.outTok)}
          </span>
          <span class="text-fg-muted truncate">
            ·{" "}
            {mx.reasoningTok > 0
              ? `${compactTokens(mx.netOutTok)} completion`
              : "Completion tokens"}
            {costSuffix(costs()?.output)}
          </span>
        </>
      );
    }
    if (z === "reasoning") {
      return (
        <>
          <span class="h-2 w-2 rounded-[2px] bg-tone-amber shrink-0" />
          <span class="font-medium text-fg shrink-0">Reasoning</span>
          <span class="font-mono tabular-nums text-fg-secondary shrink-0">
            {compactTokens(mx.reasoningTok)}
          </span>
          <span class="text-fg-muted truncate">
            · Thinking tokens{costSuffix(costs()?.reasoning)}
          </span>
        </>
      );
    }
    if (z === "context") {
      return (
        <>
          <span class="h-2 w-2 rounded-[2px] bg-accent shrink-0" />
          <span class="font-medium text-fg shrink-0">Active context</span>
          <span class="font-mono tabular-nums text-fg-secondary shrink-0">
            {compactTokens(cm.used ?? 0)}
          </span>
          <span class="text-fg-muted truncate">· Conversation window</span>
        </>
      );
    }
    if (z === "usable") {
      const freeVal =
        cm.usableRemaining ?? Math.max(0, cm.window - (cm.used ?? 0));
      return (
        <>
          <span class="h-2 w-2 rounded-[2px] bg-success shrink-0" />
          <span class="font-medium text-fg shrink-0">Usable free</span>
          <span class="font-mono tabular-nums text-fg-secondary shrink-0">
            {compactTokens(freeVal)}
          </span>
          <span class="text-fg-muted truncate">
            ·{" "}
            {cm.autoCompactEnabled
              ? `${cm.usableLeftPct ?? 100}% left before ${cm.autoCompactPercent}% limit`
              : "Free window capacity"}
          </span>
        </>
      );
    }
    if (z === "reserve") {
      return (
        <>
          <span class="h-2 w-2 rounded-[2px] bg-warning shrink-0" />
          <span class="font-medium text-fg shrink-0">Auto-compact buffer</span>
          <span class="font-mono tabular-nums text-fg-secondary shrink-0">
            {compactTokens(cm.reserveTokens)}
          </span>
          <span class="text-fg-muted truncate">
            · Reserved above {cm.autoCompactPercent}%
          </span>
        </>
      );
    }

    if (isSweeping() && sweepP() < 0.96 && (cm.used ?? 0) > 0 && cm.window > 0) {
      return (
        <>
          <span class="h-1.5 w-1.5 rounded-full bg-accent animate-pulse shrink-0" />
          <span class="font-medium text-fg-secondary shrink-0">Scanning context</span>
          <span class="text-fg-muted truncate">· Latest request + response</span>
        </>
      );
    }

    if (isReceding() && recedeP() < 0.96 && cm.window > 0) {
      const freedLive = Math.max(0, Math.round(freedTokens() * recedeP()));
      return (
        <>
          <span class="h-1.5 w-1.5 rounded-full bg-accent animate-pulse shrink-0" />
          <span class="font-medium text-fg-secondary shrink-0">Compacting context…</span>
          <span class="text-fg-muted tabular-nums truncate">
            · Freeing {compactTokens(freedLive > 0 ? freedLive : freedTokens())}
          </span>
        </>
      );
    }

    if (cm.window <= 0) {
      return (
        <span class="text-fg-muted truncate">
          Context limit not configured. Latest request + response.
        </span>
      );
    }

    if (cm.used === null) {
      return (
        <>
          <span class="h-1.5 w-1.5 rounded-full bg-accent shrink-0" />
          <span class="font-medium text-fg tabular-nums shrink-0">
            {compactTokens(cm.usableLimit)} usable
          </span>
          <span class="text-fg-muted truncate">
            ·{" "}
            {cm.autoCompactEnabled
              ? `Auto-compact at ${cm.autoCompactPercent}%`
              : `${compactTokens(cm.window)} token window`}{" "}
            · Latest request + response
          </span>
        </>
      );
    }

    if (!cm.autoCompactEnabled) {
      if (freedTokens() > 0) {
        return (
          <>
            <Iconify icon="lucide:check" size={12} class="text-success shrink-0" />
            <span class="font-medium text-success tabular-nums shrink-0">
              Freed {compactTokens(freedTokens())}
            </span>
            <span class="text-fg-muted tabular-nums truncate">
              · {compactTokens(Math.max(0, cm.window - cm.used))} free
            </span>
          </>
        );
      }
      return (
        <>
          <span class="h-1.5 w-1.5 rounded-full bg-accent shrink-0" />
          <span class="font-medium text-fg tabular-nums shrink-0">
            {compactTokens(Math.max(0, cm.window - cm.used))} free
          </span>
          <span class="text-fg-muted truncate">
            · Auto-compact off · Latest request + response
          </span>
        </>
      );
    }

    if ((cm.usableRemaining ?? 0) === 0) {
      return (
        <>
          <span class="h-1.5 w-1.5 rounded-full bg-warning shrink-0" />
          <span class="font-medium text-warning tabular-nums shrink-0">
            Auto-compact armed
          </span>
          <span class="text-fg-muted tabular-nums truncate">
            ·{" "}
            {cm.overThresholdTokens > 0
              ? `+${compactTokens(cm.overThresholdTokens)} over `
              : "at "}
            {compactTokens(cm.usableLimit)} ({cm.autoCompactPercent}%)
          </span>
        </>
      );
    }

    if (freedTokens() > 0) {
      return (
        <>
          <Iconify icon="lucide:check" size={12} class="text-success shrink-0" />
          <span class="font-medium text-success tabular-nums shrink-0">
            Freed {compactTokens(freedTokens())}
          </span>
          <span class="text-fg-muted tabular-nums truncate">
            · {compactTokens(cm.usableRemaining!)} usable left
          </span>
        </>
      );
    }

    return (
      <>
        <span class="h-1.5 w-1.5 rounded-full bg-success shrink-0" />
        <span class="font-medium text-fg tabular-nums shrink-0">
          {compactTokens(cm.usableRemaining!)} usable left
        </span>
        <span class="text-fg-muted tabular-nums truncate">
          · {cm.usableUsedPct}% of {compactTokens(cm.usableLimit)} ({cm.autoCompactPercent}% auto)
        </span>
      </>
    );
  };

  const bindZoneTrigger = (zoneId: ContextZoneId) => ({
    ref: (el: HTMLElement) => {
      cellRefs[zoneId] = el;
      onCleanup(() => {
        if (cellRefs[zoneId] === el) delete cellRefs[zoneId];
      });
    },
    onPointerDown: (e: PointerEvent) => {
      lastCellPointerType = e.pointerType || "mouse";
      press(e.currentTarget as HTMLElement);
    },
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType === "mouse") {
        setPinnedZone(null);
        setHoveredZone(zoneId);
      }
    },
    onPointerLeave: (e: PointerEvent) => {
      if (e.pointerType === "mouse") {
        setHoveredZone((prev) => (prev === zoneId ? null : prev));
      }
    },
    onFocus: (e: FocusEvent) => {
      const target = e.currentTarget as HTMLElement;
      if (target.matches?.(":focus-visible")) {
        setHoveredZone(zoneId);
      }
    },
    onBlur: () => {
      setHoveredZone((prev) => (prev === zoneId ? null : prev));
    },
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      if (lastCellPointerType !== "mouse" || e.detail === 0) {
        setHoveredZone(null);
        setPinnedZone((prev) => (prev === zoneId ? null : zoneId));
      }
    },
  });

  const telemetryCells = createMemo(() => {
    const mx = mix();
    const cObj = costs();
    const hp = hitPct();
    return [
      {
        id: "input" as const,
        label: "Input",
        swatchClass: "bg-tone-sky",
        tokens: mx.inTok,
        sub: "Uncached",
        cost: cObj?.input,
      },
      {
        id: "cache" as const,
        label: "Cache",
        swatchClass: "bg-tone-teal",
        tokens: mx.cacheTok,
        sub: hp !== null ? `${hp}% hit` : "Cached",
        cost: cObj?.cache,
      },
      {
        id: "output" as const,
        label: "Output",
        swatchClass: "bg-tone-violet",
        tokens: mx.outTok,
        sub: mx.reasoningTok > 0 ? `${compactTokens(mx.netOutTok)} text` : "Completion",
        cost: cObj?.output,
      },
      {
        id: "reasoning" as const,
        label: "Reasoning",
        swatchClass: "bg-tone-amber",
        tokens: mx.reasoningTok,
        sub: "Thinking",
        cost: cObj?.reasoning,
      },
    ];
  });

  const primaryHeadlineContent = (): JSX.Element => {
    const used = untrack(usedTokens);
    const win = untrack(windowTokens);
    const p = sweepP();
    if (!reducedMotion() && isSweeping() && p < 0.995 && used !== null && used > 0 && win > 0) {
      return `${isEstimated() ? "~" : ""}${compactTokens(Math.round(used * p))}`;
    }
    if (!reducedMotion() && isReceding() && recedeP() < 0.998) {
      const eff = effectiveUsed();
      if (eff !== null && win > 0) {
        return `${isEstimated() ? "~" : ""}${compactTokens(eff)}`;
      }
    }
    return props.settledHeadline;
  };

  const pctHeroToneClass = () => {
    const win = windowTokens();
    const eff = effectiveUsed();
    const p =
      isReceding() && eff !== null && win > 0
        ? Math.round((eff * 100) / win)
        : (props.pct() ?? 0);
    if (p >= 92) return "text-danger";
    if (math().isArmed || p >= 78) return "text-warning";
    return "text-accent";
  };

  const pctHeroContent = (): JSX.Element => {
    const targetPct = props.pct();
    const p = sweepP();
    if (
      targetPct !== null &&
      !reducedMotion() &&
      isSweeping() &&
      p < 0.995 &&
      (untrack(usedTokens) ?? 0) > 0 &&
      untrack(windowTokens) > 0
    ) {
      return `${Math.round(targetPct * p)}% full`;
    }
    if (!reducedMotion() && isReceding() && recedeP() < 0.998) {
      const eff = effectiveUsed();
      const win = windowTokens();
      if (eff !== null && win > 0) {
        return `${Math.round((eff * 100) / win)}% full`;
      }
    }
    return props.settledPctLabel;
  };

  return (
    <div class="px-2 pt-2 pb-1 text-xs select-none" data-context-meter>
      {/* Eyebrow & Replay Action Row */}
      <div class="flex items-center justify-between gap-2">
        <span class="text-2xs font-medium text-fg-muted">Conversation context</span>
        <Show when={(usedTokens() ?? 0) > 0 && windowTokens() > 0}>
          <button
            type="button"
            data-context-rescan
            data-rc-tip="Replay context scan"
            aria-label="Replay context scan"
            onPointerDown={(e) => press(e.currentTarget)}
            onClick={(e) => {
              e.stopPropagation();
              triggerReplay();
            }}
            class="h-5 px-1.5 -mr-1 rounded-md inline-flex items-center gap-1 text-2xs text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer shrink-0"
          >
            <Iconify
              icon="lucide:refresh-cw"
              size={11}
              class={isSweeping() ? "animate-spin text-accent" : ""}
            />
            <span>Rescan</span>
          </button>
        </Show>
      </div>

      {/* Primary Hero Metric Cluster: `96.4K  48% full` + `of 200K · 160K usable` */}
      <div class="mt-1 flex items-baseline justify-between gap-2">
        <div class="inline-flex items-baseline gap-2 min-w-0 shrink-0">
          <span
            data-context-primary-figure
            class="font-mono text-xl font-medium tabular-nums tracking-tight text-fg shrink-0"
          >
            {primaryHeadlineContent()}
          </span>
          <Show when={props.pct() !== null}>
            <span
              data-context-pct-hero
              class={`font-mono text-[15px] font-medium tabular-nums tracking-tight shrink-0 transition-colors ${pctHeroToneClass()}`}
            >
              {pctHeroContent()}
            </span>
          </Show>
        </div>

        <span class="text-2xs font-normal tabular-nums text-fg-muted truncate text-right">
          <Show
            when={windowTokens() > 0}
            fallback={<>Context limit not configured</>}
          >
            of {compactTokens(windowTokens())}
            <Show when={math().autoCompactEnabled} fallback={<> window</>}>
              {" · "}
              <span class={math().isArmed ? "text-warning font-medium" : "text-fg-secondary"}>
                {compactTokens(math().usableLimit)} usable
              </span>
            </Show>
          </Show>
        </span>
      </div>

      {/* Dynamic 1-Line Morphing Subtitle (fixed 18px slot, zero vertical layout shift) */}
      <div
        data-context-subtitle
        data-subtitle-state={subtitleStateKey()}
        class="mt-1.5 h-[18px] flex items-center overflow-hidden text-xs"
      >
        <div
          ref={(el) => {
            subtitleInnerEl = el;
          }}
          class="flex items-center gap-1.5 min-w-0 w-full"
        >
          {renderSubtitleContent()}
        </div>
      </div>

      {/* Centerpiece Unified Segmented Dot-Matrix Bar */}
      <div
        role="progressbar"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, props.pct() ?? 0)}
        data-context-bar
        onPointerDown={(e) => {
          if (e.pointerType !== "mouse") {
            touchStart = { id: e.pointerId, x: e.clientX, y: e.clientY };
          }
        }}
        onPointerMove={(e) => {
          if (e.pointerType !== "mouse") return;
          const rect = e.currentTarget.getBoundingClientRect();
          setPinnedZone(null);
          setHoveredZone(hitTestBarZone(zones(), e.clientX - rect.left));
        }}
        onPointerUp={(e) => {
          if (e.pointerType !== "mouse" && touchStart && touchStart.id === e.pointerId) {
            const moved = Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y);
            touchStart = null;
            if (moved < 10) {
              const rect = e.currentTarget.getBoundingClientRect();
              const hit = hitTestBarZone(zones(), e.clientX - rect.left);
              setHoveredZone(null);
              setPinnedZone((prev) => (prev === hit ? null : hit));
            }
          }
        }}
        onPointerCancel={() => {
          touchStart = null;
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") {
            setHoveredZone(null);
          }
        }}
        class="relative mt-2.5 h-[42px] min-[375px]:h-[46px] rounded-[10px] select-none touch-pan-y cursor-crosshair"
      >
        <canvas
          ref={setCanvasEl}
          aria-hidden="true"
          class="block w-full h-full pointer-events-none"
        />
      </div>

      {/* Session Telemetry & Usable Partition Interactive Grid */}
      <div class="mt-3 pt-2.5 border-t border-border-subtle space-y-2">
        <div class="flex items-center justify-between gap-2">
          <span class="inline-flex items-baseline gap-1.5 min-w-0">
            <span class="text-2xs font-medium text-fg-muted shrink-0">Session telemetry</span>
            <span class="text-2xs text-fg-muted/80 truncate">· Latest request + response</span>
          </span>
          <Show when={costs() && costs()!.total > 0}>
            <span class="font-mono text-2xs font-medium text-fg tabular-nums shrink-0">
              ${fmtUsd(costs()!.total)}
            </span>
          </Show>
        </div>

        <Show when={!usage()}>
          <p class="text-fg-muted text-2xs leading-snug">
            No usage reported yet. Run a turn to inspect input, cache, and output tokens.
          </p>
        </Show>

        <Show when={Boolean(usage()) || windowTokens() > 0}>
          <div
            ref={setGlideContainer}
            data-telemetry-grid
            class="relative grid grid-cols-2 gap-1"
          >
            <span
              ref={setGlideIndicator}
              aria-hidden="true"
              data-telemetry-glide
              class="pointer-events-none absolute left-0 top-0 rounded-lg bg-surface-muted border border-border-subtle opacity-0"
            />

            <Show when={usage()}>
              <For each={telemetryCells()}>
                {(item) => {
                  const trigger = bindZoneTrigger(item.id);
                  const isSpot = () => activeZone() === item.id;
                  const isDimmed = () =>
                    activeZone() !== null && activeZone() !== item.id;
                  return (
                    <button
                      type="button"
                      ref={trigger.ref}
                      data-telemetry-cell={item.id}
                      aria-pressed={pinnedZone() === item.id}
                      onPointerDown={trigger.onPointerDown}
                      onPointerEnter={trigger.onPointerEnter}
                      onPointerLeave={trigger.onPointerLeave}
                      onFocus={trigger.onFocus}
                      onBlur={trigger.onBlur}
                      onClick={trigger.onClick}
                      class={`group relative z-10 flex flex-col justify-center rounded-lg px-2 py-1.5 text-left cursor-pointer transition-opacity duration-150 ${
                        isDimmed() ? "opacity-55" : "opacity-100"
                      }`}
                    >
                      <span class="flex items-center justify-between gap-1.5 w-full">
                        <span class="inline-flex items-center gap-1.5 min-w-0">
                          <span
                            class={`h-2 w-2 rounded-[2px] shrink-0 ${item.swatchClass}`}
                          />
                          <span
                            class={`text-xs transition-colors ${
                              isSpot()
                                ? "font-medium text-fg"
                                : "text-fg-secondary group-hover:text-fg"
                            }`}
                          >
                            {item.label}
                          </span>
                        </span>
                        <span class="font-mono text-xs font-medium tabular-nums text-fg shrink-0">
                          {compactTokens(item.tokens)}
                        </span>
                      </span>
                      <span class="mt-0.5 flex items-center justify-between gap-1 pl-3.5 text-2xs text-fg-muted tabular-nums w-full">
                        <span>{item.sub}</span>
                        <Show when={costs()}>
                          <span class="font-mono">${fmtUsd(item.cost || 0)}</span>
                        </Show>
                      </span>
                    </button>
                  );
                }}
              </For>
            </Show>

            {/* Interactive Usable Headroom & Auto-Compact Reserve Triggers */}
            <Show when={windowTokens() > 0}>
              {(() => {
                const usableTrigger = bindZoneTrigger("usable");
                const reserveTrigger = bindZoneTrigger("reserve");
                const usableSpot = () => activeZone() === "usable";
                const reserveSpot = () => activeZone() === "reserve";
                const usableDim = () =>
                  activeZone() !== null && activeZone() !== "usable";
                const reserveDim = () =>
                  activeZone() !== null && activeZone() !== "reserve";

                return (
                  <>
                    <button
                      type="button"
                      ref={usableTrigger.ref}
                      data-telemetry-cell="usable"
                      aria-pressed={pinnedZone() === "usable"}
                      onPointerDown={usableTrigger.onPointerDown}
                      onPointerEnter={usableTrigger.onPointerEnter}
                      onPointerLeave={usableTrigger.onPointerLeave}
                      onFocus={usableTrigger.onFocus}
                      onBlur={usableTrigger.onBlur}
                      onClick={usableTrigger.onClick}
                      class={`group relative z-10 flex items-center justify-between gap-1.5 rounded-lg px-2 py-1 text-left cursor-pointer transition-opacity duration-150 ${
                        math().autoCompactEnabled ? "" : "col-span-2"
                      } ${usableDim() ? "opacity-55" : "opacity-100"}`}
                    >
                      <span class="inline-flex items-center gap-1.5 min-w-0">
                        <span
                          class={`h-2 w-2 rounded-[2px] shrink-0 ${
                            math().isArmed ? "bg-warning" : "bg-success"
                          }`}
                        />
                        <span
                          class={`text-2xs transition-colors ${
                            usableSpot()
                              ? "font-medium text-fg"
                              : "text-fg-secondary group-hover:text-fg"
                          }`}
                        >
                          Usable free
                        </span>
                      </span>
                      <span
                        class={`font-mono text-2xs font-medium tabular-nums shrink-0 ${
                          math().isArmed ? "text-warning" : "text-fg"
                        }`}
                      >
                        {math().isArmed
                          ? "Armed"
                          : compactTokens(
                              math().usableRemaining ??
                                Math.max(0, windowTokens() - (usedTokens() ?? 0)),
                            )}
                      </span>
                    </button>

                    <Show when={math().autoCompactEnabled}>
                      <button
                        type="button"
                        ref={reserveTrigger.ref}
                        data-telemetry-cell="reserve"
                        aria-pressed={pinnedZone() === "reserve"}
                        onPointerDown={reserveTrigger.onPointerDown}
                        onPointerEnter={reserveTrigger.onPointerEnter}
                        onPointerLeave={reserveTrigger.onPointerLeave}
                        onFocus={reserveTrigger.onFocus}
                        onBlur={reserveTrigger.onBlur}
                        onClick={reserveTrigger.onClick}
                        class={`group relative z-10 flex items-center justify-between gap-1.5 rounded-lg px-2 py-1 text-left cursor-pointer transition-opacity duration-150 ${
                          reserveDim() ? "opacity-55" : "opacity-100"
                        }`}
                      >
                        <span class="inline-flex items-center gap-1.5 min-w-0">
                          <span class="h-2 w-2 rounded-[2px] bg-warning shrink-0" />
                          <span
                            class={`text-2xs transition-colors ${
                              reserveSpot()
                                ? "font-medium text-fg"
                                : "text-fg-secondary group-hover:text-fg"
                            }`}
                          >
                            Buffer
                          </span>
                        </span>
                        <span class="font-mono text-2xs font-medium tabular-nums text-fg shrink-0">
                          {compactTokens(math().reserveTokens)}
                        </span>
                      </button>
                    </Show>
                  </>
                );
              })()}
            </Show>
          </div>
        </Show>
      </div>

      {/* Bottom Compaction Status & Settings Action Strip */}
      <div
        data-context-footer-strip
        class="mt-2.5 pt-2 border-t border-border-subtle flex items-center justify-between gap-2"
      >
        <div class="flex items-center gap-1.5 min-w-0 text-2xs text-fg-secondary">
          <Show
            when={compactionCount() > 0}
            fallback={
              <Show
                when={math().isArmed}
                fallback={
                  <Show
                    when={math().autoCompactEnabled}
                    fallback={
                      <Show
                        when={windowTokens() > 0}
                        fallback={
                          <>
                            <Iconify
                              icon="lucide:info"
                              size={12}
                              class="text-fg-muted shrink-0"
                            />
                            <span class="truncate">No window limit set</span>
                          </>
                        }
                      >
                        <Iconify
                          icon="lucide:circle-off"
                          size={12}
                          class="text-fg-muted shrink-0"
                        />
                        <span class="truncate">Auto-compact off</span>
                      </Show>
                    }
                  >
                    <Iconify
                      icon="lucide:shield-check"
                      size={12}
                      class="text-success shrink-0"
                    />
                    <span class="truncate tabular-nums">
                      Auto-compact at{" "}
                      <span class="font-medium text-fg">{math().autoCompactPercent}%</span> (
                      {compactTokens(math().usableLimit)})
                    </span>
                  </Show>
                }
              >
                <Iconify icon="lucide:zap" size={12} class="text-warning shrink-0" />
                <span class="truncate tabular-nums">
                  <span class="font-medium text-warning">Compacts next step</span> ·{" "}
                  {math().autoCompactPercent}% limit
                </span>
              </Show>
            }
          >
            <Iconify icon="lucide:layers" size={12} class="text-accent shrink-0" />
            <span class="truncate tabular-nums">
              Compacted <span class="font-medium text-fg">{compactionCount()}×</span>
              {math().autoCompactEnabled
                ? ` · Auto at ${math().autoCompactPercent}%`
                : " · Auto off"}
            </span>
          </Show>
        </div>

        <Show when={typeof m?.openSettings === "function"}>
          <button
            type="button"
            data-context-configure
            data-rc-tip="Configure auto-compaction in Settings"
            onPointerDown={(e) => press(e.currentTarget)}
            onClick={(e) => {
              e.stopPropagation();
              batch(() => {
                ui.setUsageOpen(false);
                m.openSettings?.("rc-set-runtime");
              });
            }}
            class="h-6 px-2 rounded-md bg-surface-muted hover:bg-surface-strong text-fg font-medium text-2xs inline-flex items-center gap-1 shrink-0 cursor-pointer transition-colors"
          >
            <Iconify icon="lucide:sliders-horizontal" size={11} class="text-fg-secondary" />
            <span>
              {math().autoCompactEnabled ? `Auto ${math().autoCompactPercent}%` : "Configure"}
            </span>
          </button>
        </Show>
      </div>
    </div>
  );
}
