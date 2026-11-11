import { createEffect, createMemo, createSignal, For, onCleanup, onMount } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { press } from "../../ds/motion/press";
import { reducedMotion } from "../../ds/motion/reduced";
import {
  EFFORT_SPECS,
  clientXToEffortIndex,
  resolveEffortIndex,
  stepEffortIndex,
  type EffortLevel,
} from "../utils/effortSpec";

function cellHash(col: number, row: number, seed: number): number {
  let h =
    (Math.imul(col + 11, 374761393) +
      Math.imul(row + 7, 668265263) +
      Math.imul(seed + 3, 1274126177)) |
    0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function isCellInsideRoundedTrack(
  x: number,
  y: number,
  cell: number,
  w: number,
  h: number,
  cornerRadius = 10,
  margin = 2.5,
): boolean {
  if (x < margin || y < margin || x + cell > w - margin || y + cell > h - margin) {
    return false;
  }
  const innerR = Math.max(0, cornerRadius - margin);
  const dx = Math.max(0, cornerRadius - x, x + cell - (w - cornerRadius));
  const dy = Math.max(0, cornerRadius - y, y + cell - (h - cornerRadius));
  return dx * dx + dy * dy <= innerR * innerR;
}

function sampleElementColor(
  probeCtx: CanvasRenderingContext2D,
  el: Element,
): [number, number, number] {
  const resolved = getComputedStyle(el).color;
  probeCtx.clearRect(0, 0, 1, 1);
  probeCtx.fillStyle = resolved;
  probeCtx.fillRect(0, 0, 1, 1);
  const d = probeCtx.getImageData(0, 0, 1, 1).data;
  return [d[0] ?? 128, d[1] ?? 180, d[2] ?? 240];
}

function sampleElementBgColor(
  probeCtx: CanvasRenderingContext2D,
  el: Element,
): [number, number, number] {
  const resolved = getComputedStyle(el).backgroundColor;
  probeCtx.clearRect(0, 0, 1, 1);
  probeCtx.fillStyle = resolved;
  probeCtx.fillRect(0, 0, 1, 1);
  const d = probeCtx.getImageData(0, 0, 1, 1).data;
  return [d[0] ?? 245, d[1] ?? 245, d[2] ?? 245];
}

export function EffortPickerBody(props: {
  effort: () => string;
  activeModelName: () => string;
  onEffortPreview: (lvl: EffortLevel) => void;
  onEffortCommit: (lvl: EffortLevel) => void;
  onOpenModelPicker: () => void;
  autoFocus?: boolean;
}) {
  const [dragging, setDragging] = createSignal(false);
  const [canvasEl, setCanvasEl] = createSignal<HTMLCanvasElement>();
  const [thumbEl, setThumbEl] = createSignal<HTMLSpanElement>();
  let wrapperRef: HTMLDivElement | undefined;
  let sliderRef: HTMLDivElement | undefined;
  let activePointerId: number | null = null;
  let startCommittedLevel: EffortLevel | null = null;

  const stepIdx = createMemo(() => resolveEffortIndex(props.effort()));
  const activeSpec = createMemo(() => EFFORT_SPECS[stepIdx()]!);
  const isMax = createMemo(() => activeSpec().level === "max");
  const ratio = createMemo(() => stepIdx() / (EFFORT_SPECS.length - 1));

  onMount(() => {
    if (props.autoFocus) {
      const id = window.requestAnimationFrame(() => {
        wrapperRef?.focus({ preventScroll: true });
      });
      onCleanup(() => window.cancelAnimationFrame(id));
    }
  });

  createEffect(() => {
    const maxActive = isMax();
    const reduced = reducedMotion();
    const canvas = canvasEl();
    const thumb = thumbEl();
    if (!maxActive || !canvas) return;
    if (typeof document === "undefined" || typeof window === "undefined") return;

    const ctx = canvas.getContext("2d");
    const probeCtx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!ctx || !probeCtx) return;

    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    let accentRgb: [number, number, number] = [90, 190, 175];
    let glintRgb: [number, number, number] = [170, 225, 215];
    let brightAccent = true;
    let rafId = 0;

    const refreshColors = () => {
      accentRgb = sampleElementColor(probeCtx, canvas);
      const accentLum = 0.2126 * accentRgb[0] + 0.7152 * accentRgb[1] + 0.0722 * accentRgb[2];
      brightAccent = accentLum > 138;
      if (brightAccent && thumb) {
        const thumbRgb = sampleElementBgColor(probeCtx, thumb);
        glintRgb = [
          Math.round(accentRgb[0] + (thumbRgb[0] - accentRgb[0]) * 0.42),
          Math.round(accentRgb[1] + (thumbRgb[1] - accentRgb[1]) * 0.42),
          Math.round(accentRgb[2] + (thumbRgb[2] - accentRgb[2]) * 0.42),
        ];
      } else {
        glintRgb = accentRgb;
      }
    };

    const syncSize = () => {
      const rect = canvas.getBoundingClientRect();
      const nextW = Math.max(0, Math.round(rect.width));
      const nextH = Math.max(0, Math.round(rect.height));
      const nextDpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      if (nextW === cssW && nextH === cssH && nextDpr === dpr) return;
      cssW = nextW;
      cssH = nextH;
      dpr = nextDpr;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
    };

    const drawFrame = (nowMs: number, isStatic: boolean) => {
      syncSize();
      if (cssW <= 0 || cssH <= 0) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const cell = 2;
      const pitch = 4;
      const cornerRadius = 10;
      const margin = 2.5;
      const rows = Math.max(1, Math.floor((cssH - 4) / pitch));
      const cols = Math.max(1, Math.floor((cssW - 4) / pitch));
      const gridH = rows * pitch - (pitch - cell);
      const gridW = cols * pitch - (pitch - cell);
      const y0 = Math.round((cssH - gridH) / 2);
      const x0 = Math.round((cssW - gridW) / 2);
      const t = isStatic ? 1.85 : nowMs * 0.001;

      for (let c = 0; c < cols; c++) {
        const u = cols > 1 ? c / (cols - 1) : 1;
        if (u <= 0.18) continue;
        const ramp = (u - 0.18) / 0.82;
        const density = Math.min(0.97, Math.pow(ramp, 0.72) * 1.12);
        const x = x0 + c * pitch;

        for (let r = 0; r < rows; r++) {
          const y = y0 + r * pitch;
          if (!isCellInsideRoundedTrack(x, y, cell, cssW, cssH, cornerRadius, margin)) continue;

          const h0 = cellHash(c, r, 1);
          if (h0 > density) continue;

          const phase = cellHash(c, r, 2) * Math.PI * 2;
          const speed = 1.5 + cellHash(c, r, 3) * 2.2;
          const twinkle = 0.5 + 0.5 * Math.sin(t * speed + phase);
          const wave =
            0.5 +
            0.5 * Math.sin(t * 2.1 - c * 0.16 + Math.sin(r * 0.9) * 0.45 + phase * 0.35);
          const spark = 0.48 * twinkle + 0.52 * wave;
          const envelope = Math.pow(ramp, 0.78);
          const alpha = envelope * (0.18 + 0.82 * Math.pow(spark, 1.35));
          if (alpha < 0.03) continue;

          const rgb = brightAccent && spark > 0.78 && u > 0.42 ? glintRgb : accentRgb;
          ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Math.min(1, alpha).toFixed(3)})`;
          ctx.fillRect(x, y, cell, cell);
        }
      }
    };

    refreshColors();
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
        refreshColors();
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
    }

    onCleanup(() => {
      if (rafId) window.cancelAnimationFrame(rafId);
      ro?.disconnect();
      mo?.disconnect();
    });
  });

  const levelFromPointer = (el: HTMLElement, clientX: number): EffortLevel => {
    const rect = el.getBoundingClientRect();
    const idx = clientXToEffortIndex(clientX, rect.left, rect.width);
    return EFFORT_SPECS[idx]!.level;
  };

  const finishPointer = (e: PointerEvent, revert: boolean) => {
    if (activePointerId !== e.pointerId) return;
    const startLvl = startCommittedLevel;
    activePointerId = null;
    startCommittedLevel = null;
    setDragging(false);
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {}
    }
    if (revert) {
      if (startLvl && startLvl !== EFFORT_SPECS[stepIdx()]!.level) {
        props.onEffortPreview(startLvl);
      }
      return;
    }
    const finalLvl =
      e.type === "pointerup" ? levelFromPointer(el, e.clientX) : EFFORT_SPECS[stepIdx()]!.level;
    if (finalLvl !== EFFORT_SPECS[stepIdx()]!.level) {
      props.onEffortPreview(finalLvl);
    }
    if (finalLvl !== startLvl) {
      props.onEffortCommit(finalLvl);
    }
  };

  const handleStepKey = (e: KeyboardEvent, moveFocusToSlider: boolean) => {
    const nextIdx = stepEffortIndex(stepIdx(), e.key);
    if (nextIdx === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (moveFocusToSlider) {
      sliderRef?.focus({ preventScroll: true });
    }
    if (nextIdx === stepIdx()) return;
    const nextLvl = EFFORT_SPECS[nextIdx]!.level;
    props.onEffortPreview(nextLvl);
    props.onEffortCommit(nextLvl);
  };

  return (
    <div
      ref={(el) => {
        wrapperRef = el;
      }}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget) handleStepKey(e, true);
      }}
      class="px-2.5 py-2 focus:outline-none"
      data-effort-picker
    >
      <div class="flex items-center justify-between gap-2.5">
        <span class="inline-flex items-baseline gap-1.5 shrink-0">
          <span class="text-[13px] font-normal text-fg-muted">Effort</span>
          <span
            data-effort-title
            class={`text-[13px] font-medium transition-colors duration-150 ${
              isMax() ? "text-accent" : "text-fg"
            }`}
          >
            {activeSpec().title}
          </span>
        </span>
        <button
          type="button"
          data-effort-model-btn
          aria-label={`Select model: ${props.activeModelName()}`}
          onPointerDown={(e) => press(e.currentTarget)}
          onClick={(e) => {
            e.stopPropagation();
            props.onOpenModelPicker();
          }}
          class="group inline-flex items-center gap-1 max-w-[11.5rem] min-w-0 rounded-md px-1.5 py-0.5 -mr-1 text-xs font-medium text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
        >
          <span class="truncate">{props.activeModelName()}</span>
          <Iconify
            icon="lucide:chevrons-up-down"
            size={12}
            class="shrink-0 text-fg-muted group-hover:text-fg-secondary transition-colors"
          />
        </button>
      </div>

      <div class="mt-3 mb-1.5 flex items-center justify-between text-[11px] text-fg-muted select-none">
        <span>Faster</span>
        <span>Smarter</span>
      </div>

      <div
        ref={(el) => {
          sliderRef = el;
        }}
        role="slider"
        tabIndex={0}
        aria-label="Reasoning effort"
        aria-valuemin={0}
        aria-valuemax={EFFORT_SPECS.length - 1}
        aria-valuenow={stepIdx()}
        aria-valuetext={`${activeSpec().title} — ${activeSpec().desc}`}
        onPointerDown={(e) => {
          if (e.button !== 0 && e.pointerType === "mouse") return;
          e.stopPropagation();
          const el = e.currentTarget;
          wrapperRef?.focus({ preventScroll: true });
          activePointerId = e.pointerId;
          startCommittedLevel = EFFORT_SPECS[stepIdx()]!.level;
          setDragging(true);
          try {
            el.setPointerCapture(e.pointerId);
          } catch {}
          const nextLvl = levelFromPointer(el, e.clientX);
          if (nextLvl !== EFFORT_SPECS[stepIdx()]!.level) {
            props.onEffortPreview(nextLvl);
          }
        }}
        onPointerMove={(e) => {
          if (activePointerId !== e.pointerId) return;
          const nextLvl = levelFromPointer(e.currentTarget, e.clientX);
          if (nextLvl !== EFFORT_SPECS[stepIdx()]!.level) {
            props.onEffortPreview(nextLvl);
          }
        }}
        onPointerUp={(e) => finishPointer(e, false)}
        onPointerCancel={(e) => finishPointer(e, true)}
        onLostPointerCapture={(e) => finishPointer(e, false)}
        onKeyDown={(e) => handleStepKey(e, false)}
        class="relative h-9 rounded-[10px] overflow-hidden isolate select-none touch-none cursor-pointer"
      >
        {/* Normal recessed track surface, left progress fill, and 7 discrete stop dots */}
        <div
          aria-hidden="true"
          class={`absolute inset-0 rounded-[inherit] overflow-hidden pointer-events-none transition-opacity duration-150 ${
            isMax() ? "opacity-0" : "opacity-100"
          }`}
          style={{
            background: "color-mix(in oklab, var(--control-track) 55%, var(--surface-muted))",
          }}
        >
          <div
            class="absolute inset-y-0 left-0 bg-fg/[0.08]"
            style={{
              width: `calc(14px + ${ratio()} * (100% - 28px))`,
            }}
          />
          <For each={EFFORT_SPECS}>
            {(_, i) => (
              <span
                data-effort-dot={i()}
                class="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-[3px] h-[3px] rounded-full bg-fg-muted/60"
                style={{
                  left: `calc(14px + ${i() / (EFFORT_SPECS.length - 1)} * (100% - 28px))`,
                }}
              />
            )}
          </For>
        </div>

        {/* Max accent atmosphere + animated pixel matrix */}
        <div
          aria-hidden="true"
          class={`absolute inset-0 rounded-[inherit] overflow-hidden pointer-events-none transition-opacity duration-200 ${
            isMax() ? "opacity-100" : "opacity-0"
          }`}
          style={{
            background:
              "linear-gradient(90deg, color-mix(in oklab, var(--accent) 12%, var(--surface-muted)) 0%, color-mix(in oklab, var(--accent) 18%, var(--surface)) 55%, color-mix(in oklab, var(--accent) 24%, var(--surface)) 100%)",
          }}
        >
          <canvas
            ref={setCanvasEl}
            aria-hidden="true"
            class="absolute inset-0 w-full h-full rounded-[inherit] pointer-events-none text-accent"
          />
        </div>

        {/* Single topmost border hairline sealing the rounded corners */}
        <span
          aria-hidden="true"
          data-effort-track-ring
          class="pointer-events-none absolute inset-0 rounded-[inherit] transition-[box-shadow] duration-200"
          style={{
            "box-shadow": isMax()
              ? "inset 0 0 0 1px color-mix(in oklab, var(--accent) 26%, transparent)"
              : "inset 0 0 0 1px color-mix(in oklab, var(--border) 55%, transparent)",
          }}
        />

        {/* Tactile pill thumb */}
        <span
          ref={setThumbEl}
          aria-hidden="true"
          data-effort-thumb
          class={`absolute top-1 w-[20px] h-[28px] rounded-[6px] pointer-events-none bg-[var(--control-thumb)] [box-shadow:var(--control-thumb-shadow)] ${
            dragging() ? "transition-none" : "transition-[left] duration-100 ease-out"
          }`}
          style={{
            left: `calc(4px + ${ratio()} * (100% - 28px))`,
          }}
        />
      </div>

      <p data-effort-desc class="mt-2.5 text-xs text-fg-secondary leading-snug">
        {activeSpec().desc}
      </p>
    </div>
  );
}
