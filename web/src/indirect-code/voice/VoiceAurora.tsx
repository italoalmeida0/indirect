import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { reducedMotion } from "../../ds/motion/reduced";
import { accent, theme } from "../../ui";
import { DotMatrixAurora, type AuroraMode } from "./aurora";

export function VoiceAmbientGlow(props: { mode: AuroraMode }) {
  return (
    <div
      aria-hidden="true"
      class="rc-voice-ambient"
      data-voice-mode={props.mode === "idle" ? undefined : props.mode}
    />
  );
}

export function VoiceAuroraCanvas(props: {
  mode: AuroraMode;
  progress?: number;
  hostEl?: HTMLElement | null;
  onBindController?: (controller: DotMatrixAurora | null) => void;
}) {
  const [canvasEl, setCanvasEl] = createSignal<HTMLCanvasElement>();
  const [controller, setController] = createSignal<DotMatrixAurora | null>(null);

  createEffect(() => {
    const canvas = canvasEl();
    if (!canvas || typeof window === "undefined") return;

    const host = untrack(
      () =>
        props.hostEl ??
        (canvas.closest(".rc-composer") as HTMLElement | null) ??
        canvas.parentElement,
    );
    const aurora = new DotMatrixAurora(canvas, host);
    aurora.setReducedMotion(untrack(() => reducedMotion()));
    aurora.setProgress(untrack(() => props.progress ?? 0));
    aurora.setMode(untrack(() => props.mode));
    setController(aurora);
    untrack(() => props.onBindController?.(aurora));

    let mo: MutationObserver | undefined;
    if (typeof MutationObserver === "function" && typeof document !== "undefined") {
      mo = new MutationObserver(() => {
        aurora.refreshPalette();
      });
      mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-accent"],
      });
    }

    onCleanup(() => {
      mo?.disconnect();
      untrack(() => props.onBindController?.(null));
      setController(null);
      aurora.destroy();
    });
  });

  createEffect(() => {
    const aurora = controller();
    const host = props.hostEl;
    if (!aurora || !host) return;
    aurora.setHost(host);
  });

  createEffect(() => {
    const aurora = controller();
    const mode = props.mode;
    if (!aurora) return;
    aurora.setMode(mode);
  });

  createEffect(() => {
    const aurora = controller();
    const progress = props.progress ?? 0;
    if (!aurora) return;
    aurora.setProgress(progress);
  });

  createEffect(() => {
    const aurora = controller();
    theme();
    accent();
    if (!aurora) return;
    aurora.refreshPalette();
  });

  createEffect(() => {
    const aurora = controller();
    const reduced = reducedMotion();
    if (!aurora) return;
    aurora.setReducedMotion(reduced);
  });

  return (
    <div aria-hidden="true" class="rc-voice-aurora-clip">
      <canvas ref={setCanvasEl} class="rc-voice-aurora-canvas" />
    </div>
  );
}
