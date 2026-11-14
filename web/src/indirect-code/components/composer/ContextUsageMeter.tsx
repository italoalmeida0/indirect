import {
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
  computeBarZones,
  computeContextMeterMath,
  computeTokenMix,
  hitTestBarZone,
  resolveContextUsed,
  type ContextSegmentId,
  type ContextZoneId,
} from "../../utils/contextMeter";

type Rgb = [number, number, number];

const SWEEP_DURATION_MS = 780;
const TRACK_RADIUS = 10;
const INNER_PAD = 2.5;
const SEG_STROKE_W = 1.5;

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
  const [barWidth, setBarWidth] = createSignal(320);

  const [canvasEl, setCanvasEl] = createSignal<HTMLCanvasElement>();
  const [glideContainer, setGlideContainer] = createSignal<HTMLDivElement>();
  const [glideIndicator, setGlideIndicator] = createSignal<HTMLSpanElement>();

  let subtitleInnerEl: HTMLDivElement | undefined;
  let lastSubtitleKey = "";
  let touchStart: { id: number; x: number; y: number } | null = null;
  let lastCellPointerType = "mouse";
  const cellRefs: Partial<Record<ContextZoneId, HTMLElement>> = {};

  const autoCompactPercent = createMemo(
    () => m?.daemonSettings?.()?.autoCompactPercent ?? 80,
  );

  const rawCtx = () => c.activeContext();
  const usedTokens = createMemo(() => resolveContextUsed(rawCtx()));
  const windowTokens = createMemo(() => rawCtx().window || 0);
  const isEstimated = createMemo(() => rawCtx().tokensLabel?.startsWith("~") ?? false);

  const math = createMemo(() =>
    computeContextMeterMath({
      used: usedTokens(),
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
      used: usedTokens(),
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
    if (reducedMotion()) {
      setSweepP(1);
      setIsSweeping(false);
      return;
    }
    setSweepEpoch((n) => n + 1);
  };

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
    // eliminates subpixel browser CSS stretch and left/right edge clipping.
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

    const drawFrame = (nowMs: number, isStatic: boolean) =>
      untrack(() => {
        syncSize();
        if (cssW <= 4 || cssH <= 4) return;

        const dt = clamp((nowMs - lastFrameMs) * 0.001, 0, 0.08);
        lastFrameMs = nowMs;

        const used = usedTokens();
        const win = windowTokens();
        const hasSweepableFill = !isStatic && used !== null && used > 0 && win > 0;

        let uTime = 1;
        let curSweepP = 1;
        if (hasSweepableFill) {
          if (sweepStartMs === null) sweepStartMs = nowMs;
          uTime = clamp((nowMs - sweepStartMs) / SWEEP_DURATION_MS, 0, 1);
          curSweepP = uTime >= 1 ? 1 : 1 - Math.pow(1 - uTime, 2.4);
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
        const currentMath = math();
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
        const topY = INNER_PAD;
        const botY = cssH - INNER_PAD;
        const innerH = Math.max(0, botY - topY);
        const endOuterR = TRACK_RADIUS - INNER_PAD; // 7.5px concentric outer capsule cap
        const seamOuterR = 3.0;
        const tSec = isStatic ? 1.85 : nowMs * 0.001;

        const frontierX = innerLeft + zLayout.totalOccupiedW * curSweepP;
        const env =
          uTime >= 0.999
            ? 0
            : Math.sin(Math.min(1, uTime / 0.09) * Math.PI * 0.5) *
              (1 - Math.pow(Math.max(0, (uTime - 0.72) / 0.28), 2));

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
        ctx.strokeStyle = `rgba(${outerBorderRgb[0]}, ${outerBorderRgb[1]}, ${outerBorderRgb[2]}, ${
          isDark ? "0.88" : "0.92"
        })`;
        ctx.stroke();
        ctx.restore();

        // Grid geometry: cell = 2px, pitch = 3px, checkerboard quincunx (col + row) % 2 === 0
        const cell = 2;
        const pitch = 3;
        const usableInteriorH = Math.max(2, cssH - (INNER_PAD + SEG_STROKE_W) * 2);
        const usableInteriorW = Math.max(2, cssW - (INNER_PAD + SEG_STROKE_W) * 2);
        const rows = Math.max(1, Math.floor((usableInteriorH + 1) / pitch));
        const cols = Math.max(1, Math.floor((usableInteriorW + 1) / pitch));
        const gridH = rows * pitch - (pitch - cell);
        const gridW = cols * pitch - (pitch - cell);
        const x0 = Math.round((cssW - gridW) / 2);
        const y0 = Math.round((cssH - gridH) / 2);

        // ---------------------------------------------------------------------
        // Pass 1 & 2: Unused capacity capsules (Usable Free + Auto-Compact Buffer)
        // ---------------------------------------------------------------------
        const unusedStartX =
          zLayout.totalOccupiedW > 0 && curSweepP > 0.01 ? frontierX + 1.5 : innerLeft;

        // 2a. Usable Free region (`[unusedStartX .. usableEnd]`)
        const usableEnd = zLayout.thresholdX !== null ? zLayout.thresholdX - 1 : innerRight;
        if (usableEnd - unusedStartX >= 3 && innerH > 4) {
          const uX = unusedStartX;
          const uW = usableEnd - unusedStartX;
          const uLeftR = uX <= innerLeft + 0.5 ? endOuterR : seamOuterR;
          const uRightR = zLayout.thresholdX === null ? endOuterR : seamOuterR;
          const sRgb = palette.success;

          if (usableGlow > 0.01 && zLayout.usableZone) {
            ctx.save();
            ctx.beginPath();
            ctx.roundRect(
              zLayout.usableZone.x0 + 1,
              topY + 1,
              Math.max(1, zLayout.usableZone.width - 2),
              Math.max(1, innerH - 2),
              [
                Math.max(1, (zLayout.totalOccupiedW === 0 ? endOuterR : seamOuterR) - 1),
                Math.max(1, uRightR - 1),
                Math.max(1, uRightR - 1),
                Math.max(1, (zLayout.totalOccupiedW === 0 ? endOuterR : seamOuterR) - 1),
              ],
            );
            ctx.fillStyle = `rgba(${sRgb[0]}, ${sRgb[1]}, ${sRgb[2]}, ${(
              usableGlow * (isDark ? 0.1 : 0.12)
            ).toFixed(3)})`;
            ctx.fill();
            ctx.restore();
          }

          for (let col = 0; col < cols; col++) {
            const x = x0 + col * pitch;
            if (x < uX || x + cell > usableEnd) continue;
            for (let row = 0; row < rows; row++) {
              if (((col + row) & 1) !== 0) continue;
              const y = y0 + row * pitch;
              if (
                !isCellInsideCapsule(
                  x,
                  y,
                  cell,
                  uX + 1,
                  topY + 1,
                  uW - 2,
                  innerH - 2,
                  Math.max(1, uLeftR - 1),
                  Math.max(1, uRightR - 1),
                  0.2,
                )
              ) {
                continue;
              }
              let rgb: Rgb = palette.muted;
              let alpha = isDark ? 0.088 : 0.118;
              if (segSpotlighted) alpha *= 0.58;
              if (win > 0 && usableGlow > 0.01 && x >= (zLayout.usableZone?.x0 ?? uX)) {
                const uWave = 0.5 + 0.5 * Math.sin(tSec * 2.4 - col * 0.22 + row * 0.35);
                rgb = lerpRgb(palette.muted, palette.success, usableGlow * 0.88);
                alpha = lerp(alpha, (isDark ? 0.22 : 0.28) + 0.42 * uWave, usableGlow);
              }
              ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamp(alpha, 0, 1).toFixed(3)})`;
              ctx.fillRect(x, y, cell, cell);
            }
          }

          if (usableGlow > 0.02 && zLayout.usableZone && zLayout.usableZone.width >= 4) {
            const uz = zLayout.usableZone;
            const cLeftR = Math.max(
              1,
              (zLayout.totalOccupiedW === 0 ? endOuterR : seamOuterR) - SEG_STROKE_W * 0.5,
            );
            const cRightR = Math.max(1, uRightR - SEG_STROKE_W * 0.5);
            ctx.save();
            ctx.strokeStyle = `rgba(${sRgb[0]}, ${sRgb[1]}, ${sRgb[2]}, ${(0.86 * usableGlow).toFixed(3)})`;
            ctx.lineWidth = SEG_STROKE_W;
            ctx.beginPath();
            ctx.roundRect(
              uz.x0 + SEG_STROKE_W * 0.5,
              topY + SEG_STROKE_W * 0.5,
              Math.max(1, uz.width - SEG_STROKE_W),
              Math.max(1, innerH - SEG_STROKE_W),
              [cLeftR, cRightR, cRightR, cLeftR],
            );
            ctx.stroke();
            ctx.restore();
          }
        }

        // 2b. Auto-Compact Reserve Buffer capsule (`[rStart .. innerRight]`)
        if (zLayout.thresholdX !== null && innerH > 4) {
          const rStart = Math.max(unusedStartX, zLayout.thresholdX + 1);
          const rW = innerRight - rStart;
          if (rW >= 4) {
            const rLeftR = rStart <= innerLeft + 0.5 ? endOuterR : seamOuterR;
            const rRightR = endOuterR; // Always concentric with far-right track end
            const wRgb = palette.warning;
            const rLw = lerp(1.25, SEG_STROKE_W, reserveGlow);

            // Clipped reserve interior wash + socket lattice
            const inX = rStart + rLw;
            const inY = topY + rLw;
            const inW = Math.max(0, rW - rLw * 2);
            const inH = Math.max(0, innerH - rLw * 2);
            const inLR = Math.max(1, rLeftR - rLw);
            const inRR = Math.max(1, rRightR - rLw);

            if (inW > 1 && inH > 1) {
              ctx.save();
              ctx.beginPath();
              ctx.roundRect(inX, inY, inW, inH, [inLR, inRR, inRR, inLR]);
              ctx.clip();

              const rWashAlpha =
                (isDark ? 0.052 : 0.068) + reserveGlow * (isDark ? 0.1 : 0.12);
              ctx.fillStyle = `rgba(${wRgb[0]}, ${wRgb[1]}, ${wRgb[2]}, ${rWashAlpha.toFixed(3)})`;
              ctx.fillRect(inX, inY, inW, inH);

              for (let col = 0; col < cols; col++) {
                const x = x0 + col * pitch;
                if (x < inX || x + cell > inX + inW) continue;
                for (let row = 0; row < rows; row++) {
                  if (((col + row) & 1) !== 0) continue;
                  const y = y0 + row * pitch;
                  if (!isCellInsideCapsule(x, y, cell, inX, inY, inW, inH, inLR, inRR, 0.2)) {
                    continue;
                  }
                  let alpha = isDark ? 0.075 : 0.095;
                  if (segSpotlighted) alpha *= 0.58;
                  const rgb = lerpRgb(palette.muted, wRgb, 0.42 + reserveGlow * 0.58);
                  if (reserveGlow > 0.01) {
                    const rWave = 0.5 + 0.5 * Math.sin(tSec * 2.2 - col * 0.22 - row * 0.35);
                    alpha = lerp(alpha, (isDark ? 0.24 : 0.3) + 0.42 * rWave, reserveGlow);
                  }
                  ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamp(alpha, 0, 1).toFixed(3)})`;
                  ctx.fillRect(x, y, cell, cell);
                }
              }
              ctx.restore();
            }

            // Complete 4-sided concentric amber capsule border (subtle at rest, luminous on spotlight)
            const rBorderAlpha = lerp(
              segSpotlighted ? (isDark ? 0.14 : 0.18) : isDark ? 0.26 : 0.32,
              0.9,
              reserveGlow,
            );
            const cLeftR = Math.max(1, rLeftR - rLw * 0.5);
            const cRightR = Math.max(1, rRightR - rLw * 0.5);
            ctx.save();
            ctx.strokeStyle = `rgba(${wRgb[0]}, ${wRgb[1]}, ${wRgb[2]}, ${rBorderAlpha.toFixed(3)})`;
            ctx.lineWidth = rLw;
            ctx.beginPath();
            ctx.roundRect(
              rStart + rLw * 0.5,
              topY + rLw * 0.5,
              Math.max(1, rW - rLw),
              Math.max(1, innerH - rLw),
              [cLeftR, cRightR, cRightR, cLeftR],
            );
            ctx.stroke();
            ctx.restore();
          }
        }

        // ---------------------------------------------------------------------
        // Pass 3 & 4: Occupied Colored Segment Capsules (4-Sided Concentric roundRects)
        // ---------------------------------------------------------------------
        if (zLayout.totalOccupiedW > 0 && frontierX > innerLeft + 1.5 && zLayout.segments.length > 0) {
          for (let si = 0; si < zLayout.segments.length; si++) {
            const seg = zLayout.segments[si]!;
            // Mid-sweep: never draw static outline for unreached segments ahead of frontierX
            if (seg.x0 >= frontierX - 0.5) continue;

            const segEnd = Math.min(seg.x1, frontierX);
            const segW = segEnd - seg.x0;
            if (segW < 1.5) continue;

            const isLeadingSweepSeg = env > 0.01 && frontierX <= seg.x1 + 0.5;
            const touchesLeft = si === 0 && seg.x0 <= innerLeft + 0.5;
            const touchesRight = segEnd >= innerRight - 0.5;

            const outerLeftR = touchesLeft ? endOuterR : seamOuterR;
            const outerRightR = touchesRight ? endOuterR : seamOuterR;

            const baseRgb =
              seg.id === "context" && currentMath.usedRatio >= 0.92
                ? palette.danger
                : seg.id === "context" && currentMath.isArmed
                  ? palette.warning
                  : segmentBaseRgb(seg.id, palette);
            const hotRgb = lerpRgb(baseRgb, [255, 255, 255], isDark ? 0.86 : 0.62);
            const w = weights[seg.id];
            const hl = highlights[seg.id];

            const lw = SEG_STROKE_W;
            const inX = seg.x0 + lw;
            const inY = topY + lw;
            const inW = Math.max(0, segW - lw * 2);
            const inH = Math.max(0, innerH - lw * 2);
            const inLR = Math.max(1, outerLeftR - lw);
            const inRR = Math.max(1, outerRightR - lw);

            // Clipped segment interior: tinted wash + frontier plasma + quincunx LED dots
            if (inW > 0.5 && inH > 1) {
              ctx.save();
              ctx.beginPath();
              ctx.roundRect(inX, inY, inW, inH, [inLR, inRR, inRR, inLR]);
              ctx.clip();

              const washAlpha = (isDark ? 0.11 : 0.14) * w + hl * 0.07;
              ctx.fillStyle = `rgba(${baseRgb[0]}, ${baseRgb[1]}, ${baseRgb[2]}, ${clamp(
                washAlpha,
                0,
                0.45,
              ).toFixed(3)})`;
              ctx.fillRect(inX, inY, inW, inH);

              if (env > 0.01 && segEnd >= frontierX - 30) {
                if (!isDark) {
                  const plasmaStart = Math.max(inX, frontierX - 28);
                  const plasmaGrad = ctx.createLinearGradient(plasmaStart, 0, frontierX + 2, 0);
                  plasmaGrad.addColorStop(
                    0,
                    `rgba(${baseRgb[0]}, ${baseRgb[1]}, ${baseRgb[2]}, 0)`,
                  );
                  plasmaGrad.addColorStop(
                    1,
                    `rgba(${baseRgb[0]}, ${baseRgb[1]}, ${baseRgb[2]}, ${(0.32 * env).toFixed(3)})`,
                  );
                  ctx.fillStyle = plasmaGrad;
                  ctx.fillRect(plasmaStart, inY, Math.max(0, frontierX - plasmaStart + 2), inH);
                }

                const gx = frontierX - 3;
                const gy = cssH * 0.5;
                const bloom = ctx.createRadialGradient(gx, gy, 1.5, gx, gy, 26);
                bloom.addColorStop(
                  0,
                  `rgba(${hotRgb[0]}, ${hotRgb[1]}, ${hotRgb[2]}, ${(
                    (isDark ? 0.34 : 0.25) * env
                  ).toFixed(3)})`,
                );
                bloom.addColorStop(
                  0.45,
                  `rgba(${baseRgb[0]}, ${baseRgb[1]}, ${baseRgb[2]}, ${(0.15 * env).toFixed(3)})`,
                );
                bloom.addColorStop(1, `rgba(${baseRgb[0]}, ${baseRgb[1]}, ${baseRgb[2]}, 0)`);
                ctx.fillStyle = bloom;
                ctx.fillRect(Math.max(inX, gx - 28), inY, 56, inH);
              }

              for (let col = 0; col < cols; col++) {
                const x = x0 + col * pitch;
                if (x < inX || x + cell > inX + inW) continue;
                const cx = x + 1;
                const d = frontierX - cx;

                for (let row = 0; row < rows; row++) {
                  const y = y0 + row * pitch;
                  if (!isCellInsideCapsule(x, y, cell, inX, inY, inW, inH, inLR, inRR, 0.2)) {
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
                  ctx.fillStyle = `rgba(${dotRgb[0]}, ${dotRgb[1]}, ${dotRgb[2]}, ${finalAlpha.toFixed(3)})`;
                  ctx.fillRect(x, y, cell, cell);
                }
              }

              ctx.restore();
            }

            // Complete 4-sided concentric colored capsule border (NEVER clipped by outer track)
            const cLeftR = Math.max(0.75, outerLeftR - lw * 0.5);
            const cRightR = Math.max(0.75, outerRightR - lw * 0.5);
            const restedRimAlpha = (isDark ? 0.8 : 0.84) * Math.min(1, w);
            const strokeAlpha = clamp(lerp(restedRimAlpha, 0.98, hl), 0.18, 0.98);
            const frameRgb = lerpRgb(
              baseRgb,
              [255, 255, 255],
              (isDark ? 0.14 : 0.02) + hl * (isDark ? 0.22 : 0.08),
            );

            ctx.save();
            ctx.strokeStyle = `rgba(${frameRgb[0]}, ${frameRgb[1]}, ${frameRgb[2]}, ${strokeAlpha.toFixed(3)})`;
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.roundRect(
              seg.x0 + lw * 0.5,
              topY + lw * 0.5,
              Math.max(0.5, segW - lw),
              Math.max(1, innerH - lw),
              [cLeftR, cRightR, cRightR, cLeftR],
            );
            ctx.stroke();

            // Incandescent frontier right-edge glow on the leading segment during sweep
            if (isLeadingSweepSeg && segW > 4) {
              const glowStart = Math.max(seg.x0 + (touchesLeft ? 8 : 2), segEnd - 6);
              if (segEnd - glowStart > 1) {
                ctx.beginPath();
                ctx.rect(glowStart, topY - 1, segEnd - glowStart + 2, innerH + 2);
                ctx.clip();
                ctx.strokeStyle = `rgba(${hotRgb[0]}, ${hotRgb[1]}, ${hotRgb[2]}, ${(
                  0.92 * env
                ).toFixed(3)})`;
                ctx.lineWidth = lw;
                ctx.beginPath();
                ctx.roundRect(
                  seg.x0 + lw * 0.5,
                  topY + lw * 0.5,
                  Math.max(0.5, segW - lw),
                  Math.max(1, innerH - lw),
                  [cLeftR, cRightR, cRightR, cLeftR],
                );
                ctx.stroke();
              }
            }
            ctx.restore();
          }
        }

        // ---------------------------------------------------------------------
        // Pass 5: Auto-Compact Threshold Reticle Marker (`thresholdX`)
        // ---------------------------------------------------------------------
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
            (currentMath.isArmed ? 0.9 : isDark ? 0.58 : 0.66) +
              Math.max(reserveGlow, usableGlow) * 0.32,
            0,
            1,
          );
          const tickAlpha = clamp(lineAlpha + 0.22, 0, 1);

          ctx.save();
          ctx.strokeStyle = `rgba(${markerRgb[0]}, ${markerRgb[1]}, ${markerRgb[2]}, ${lineAlpha.toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 2]);
          ctx.beginPath();
          ctx.moveTo(tx, topY + 3);
          ctx.lineTo(tx, botY - 3);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = `rgba(${markerRgb[0]}, ${markerRgb[1]}, ${markerRgb[2]}, ${tickAlpha.toFixed(3)})`;
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
    const cm = math();
    if (cm.window <= 0) return "idle:no-window";
    if (cm.used === null) return `idle:empty:${cm.autoCompactPercent}`;
    if (!cm.autoCompactEnabled) return "idle:off";
    return cm.isArmed ? "idle:armed" : "idle:usable";
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
    return props.settledHeadline;
  };

  const pctHeroToneClass = () => {
    const p = props.pct() ?? 0;
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

      {/* Centerpiece Segmented Dot-Matrix Bar (DPR-exact unified canvas, zero CSS edge clipping) */}
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
              ui.setUsageOpen(false);
              m.openSettings?.("rc-set-runtime");
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
