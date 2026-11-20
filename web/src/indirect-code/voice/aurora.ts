export type AuroraMode = "idle" | "loading" | "listening" | "thinking";

type InternalAuroraMode = AuroraMode | "dissolving";
type AuroraTheme = "light" | "dark" | "high-contrast";
type Rgb = [number, number, number];

interface EmberParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: Rgb;
}

interface DissolveStreak {
  x: number;
  y: number;
  len: number;
  vx: number;
  alpha: number;
  h: number;
  color: Rgb;
}

const DEFAULT_DARK_VOICE_STOPS: Rgb[] = [
  [255, 146, 56],
  [255, 68, 128],
  [34, 232, 184],
  [56, 189, 248],
  [217, 70, 239],
  [251, 96, 56],
];

const DEFAULT_DARK_THINK_STOPS: Rgb[] = [
  [45, 212, 191],
  [56, 189, 248],
  [129, 140, 248],
  [192, 132, 252],
];

const DEFAULT_LIGHT_VOICE_STOPS: Rgb[] = [
  [216, 108, 18],
  [214, 38, 96],
  [14, 148, 118],
  [18, 118, 206],
  [164, 38, 194],
  [214, 72, 34],
];

const DEFAULT_LIGHT_THINK_STOPS: Rgb[] = [
  [16, 142, 132],
  [20, 116, 204],
  [78, 86, 208],
  [136, 68, 208],
];

const DEFAULT_HC_ACCENT: Rgb = [34, 255, 238];
const DEFAULT_HC_FG: Rgb = [255, 255, 255];

const VOICE_VAR_NAMES = [
  "--voice-aurora-voice-1",
  "--voice-aurora-voice-2",
  "--voice-aurora-voice-3",
  "--voice-aurora-voice-4",
  "--voice-aurora-voice-5",
  "--voice-aurora-voice-6",
] as const;

const THINK_VAR_NAMES = [
  "--voice-aurora-think-1",
  "--voice-aurora-think-2",
  "--voice-aurora-think-3",
  "--voice-aurora-think-4",
] as const;

function detectTheme(): AuroraTheme {
  if (typeof document === "undefined") return "dark";
  const attr = document.documentElement.dataset.theme;
  if (attr === "high-contrast") return "high-contrast";
  if (attr === "dark") return "dark";
  if (attr === "light") return "light";
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

function makeCyclicStops(stops: Rgb[]): Rgb[] {
  const first = stops[0];
  return first ? [...stops, [first[0], first[1], first[2]]] : [];
}

/**
 * Bioluminescent dot-matrix aurora canvas engine adapted for Indirect Code.
 * Sleeps completely (0 rAF frames) while idle and under reduced motion.
 */
export class DotMatrixAurora {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly probeCtx: CanvasRenderingContext2D | null;
  private hostEl: HTMLElement | null = null;

  private mode: InternalAuroraMode = "idle";
  private theme: AuroraTheme = "dark";
  private reducedMotion = false;
  private destroyed = false;

  private downloadProgress = 0;
  private width = 640;
  private height = 92;
  private dpr = 1;

  private intensity = 0;
  private paletteMix = 0;
  private voiceEnergy = 0;
  private readonly bands = new Float32Array(32);
  private fftScratch: Uint8Array<ArrayBuffer> | null = null;
  private embers: EmberParticle[] = [];
  private streaks: DissolveStreak[] = [];
  private dissolveTimer = 0;

  private mouseU = 0.5;
  private mouseActive = 0;

  private voiceStops: Rgb[] = makeCyclicStops(DEFAULT_DARK_VOICE_STOPS);
  private thinkStops: Rgb[] = makeCyclicStops(DEFAULT_DARK_THINK_STOPS);
  private coreColor: Rgb = [255, 255, 255];

  private rafId: number | null = null;
  private lastTime = 0;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onWindowResize: () => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerLeave: () => void;
  private readonly loop: (now: number) => void;

  constructor(canvas: HTMLCanvasElement, hostEl: HTMLElement | null = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.probeCtx =
      typeof document !== "undefined"
        ? document.createElement("canvas").getContext("2d", { willReadFrequently: true })
        : null;

    this.onWindowResize = () => this.resize();
    this.onPointerMove = (e: PointerEvent) => {
      if (!this.hostEl || this.mode !== "listening") return;
      const r = this.hostEl.getBoundingClientRect();
      this.mouseU = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
      this.mouseActive = 1;
    };
    this.onPointerLeave = () => {
      this.mouseActive = 0;
    };
    this.loop = (now: number) => this.stepFrame(now);

    this.canvas.dataset.auroraRunning = "false";
    this.refreshPalette();
    this.setHost(hostEl);

    if (typeof window !== "undefined") {
      window.addEventListener("resize", this.onWindowResize, { passive: true });
    }
  }

  public setHost(hostEl: HTMLElement | null): void {
    if (this.destroyed || this.hostEl === hostEl) return;
    this.detachHostListeners();
    this.hostEl = hostEl;

    if (hostEl) {
      hostEl.addEventListener("pointermove", this.onPointerMove, { passive: true });
      hostEl.addEventListener("pointerleave", this.onPointerLeave, { passive: true });
      if (typeof ResizeObserver === "function") {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(hostEl);
      }
    }
    this.resize();
  }

  public isRunning(): boolean {
    return this.rafId !== null;
  }

  public getMode(): AuroraMode {
    return this.mode === "dissolving" ? "idle" : this.mode;
  }

  public resize(): void {
    if (this.destroyed) return;
    const target = this.hostEl ?? this.canvas.parentElement;
    const rect = target?.getBoundingClientRect();
    const nextW = Math.max(280, Math.round((rect?.width ?? 600) + 40));
    const nextH = 92;
    const nextDpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;

    const pixelW = Math.round(nextW * nextDpr);
    const pixelH = Math.round(nextH * nextDpr);
    if (
      nextW === this.width &&
      nextH === this.height &&
      nextDpr === this.dpr &&
      this.canvas.width === pixelW &&
      this.canvas.height === pixelH
    ) {
      return;
    }

    this.width = nextW;
    this.height = nextH;
    this.dpr = nextDpr;
    this.canvas.width = pixelW;
    this.canvas.height = pixelH;

    if (this.reducedMotion) {
      this.renderStatic();
    }
  }

  public refreshPalette(): void {
    if (this.destroyed) return;
    this.theme = detectTheme();

    const defaultVoice =
      this.theme === "high-contrast"
        ? [
            DEFAULT_HC_ACCENT,
            DEFAULT_HC_FG,
            DEFAULT_HC_ACCENT,
            DEFAULT_HC_FG,
            DEFAULT_HC_ACCENT,
            DEFAULT_HC_FG,
          ]
        : this.theme === "light"
          ? DEFAULT_LIGHT_VOICE_STOPS
          : DEFAULT_DARK_VOICE_STOPS;

    const defaultThink =
      this.theme === "high-contrast"
        ? [DEFAULT_HC_ACCENT, DEFAULT_HC_ACCENT, DEFAULT_HC_ACCENT, DEFAULT_HC_ACCENT]
        : this.theme === "light"
          ? DEFAULT_LIGHT_THINK_STOPS
          : DEFAULT_DARK_THINK_STOPS;

    const defaultCore: Rgb =
      this.theme === "high-contrast"
        ? DEFAULT_HC_ACCENT
        : this.theme === "light"
          ? [68, 56, 178]
          : [255, 255, 255];

    const probedVoice: Rgb[] = VOICE_VAR_NAMES.map((name, i) =>
      this.probeColor(name, defaultVoice[i]!),
    );
    const probedThink: Rgb[] = THINK_VAR_NAMES.map((name, i) =>
      this.probeColor(name, defaultThink[i]!),
    );

    this.voiceStops = makeCyclicStops(probedVoice);
    this.thinkStops = makeCyclicStops(probedThink);
    this.coreColor = this.probeColor("--voice-aurora-core", defaultCore);

    if (this.reducedMotion) {
      this.renderStatic();
    }
  }

  public setReducedMotion(reduced: boolean): void {
    if (this.destroyed) return;
    const next = Boolean(reduced);
    if (this.reducedMotion === next) return;
    this.reducedMotion = next;

    if (next) {
      this.stopLoop();
      this.embers = [];
      this.streaks = [];
      if (this.mode === "dissolving") {
        this.mode = "idle";
      }
      if (this.mode === "idle") {
        this.intensity = 0;
        this.clearCanvas();
      } else {
        this.renderStatic();
      }
      return;
    }

    // Resuming motion while active
    if (
      this.mode !== "idle" ||
      this.intensity >= 0.005 ||
      this.embers.length > 0 ||
      this.streaks.length > 0
    ) {
      this.ensureRunning();
    }
  }

  public setProgress(pct: number): void {
    if (this.destroyed) return;
    const clamped = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    this.downloadProgress = clamped;
    if (this.reducedMotion && this.mode === "loading") {
      this.renderStatic();
    }
  }

  public setMode(nextMode: AuroraMode): void {
    if (this.destroyed) return;
    if (this.mode === nextMode) return;

    const wasActive =
      this.mode === "listening" || this.mode === "thinking" || this.mode === "loading";

    if (nextMode === "idle") {
      this.mouseActive = 0;
      if (this.reducedMotion || !wasActive) {
        this.mode = "idle";
        this.intensity = 0;
        this.voiceEnergy = 0;
        this.bands.fill(0);
        this.embers = [];
        this.streaks = [];
        this.stopLoop();
        this.clearCanvas();
        return;
      }
      this.triggerDissolve();
      this.ensureRunning();
      return;
    }

    this.mode = nextMode;
    this.streaks = [];
    this.dissolveTimer = 0;
    if (nextMode !== "listening") {
      this.mouseActive = 0;
    }

    if (this.reducedMotion) {
      this.stopLoop();
      this.renderStatic();
      return;
    }

    this.ensureRunning();
  }

  public feedAudio(analyser: AnalyserNode | null, rms: number): void {
    if (this.destroyed) return;
    const safeRms = Number.isFinite(rms) && rms > 0 ? rms : 0;
    this.voiceEnergy = this.voiceEnergy * 0.62 + Math.min(1, safeRms * 8.2) * 0.38;

    if (analyser) {
      const binCount = analyser.frequencyBinCount;
      if (binCount > 0) {
        if (!this.fftScratch || this.fftScratch.length !== binCount) {
          this.fftScratch = new Uint8Array(new ArrayBuffer(binCount));
        }
        analyser.getByteFrequencyData(this.fftScratch);
        const usable = Math.min(binCount, 48);
        for (let i = 0; i < this.bands.length; i++) {
          const idx = Math.floor((i / this.bands.length) * usable);
          const v = (this.fftScratch[idx] ?? 0) / 255;
          this.bands[i] = (this.bands[i] ?? 0) * 0.58 + v * 0.42;
        }
      }
    }
  }

  public clearAudio(): void {
    this.voiceEnergy = 0;
    this.bands.fill(0);
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopLoop();
    this.detachHostListeners();
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", this.onWindowResize);
    }
    this.embers = [];
    this.streaks = [];
    this.fftScratch = null;
    this.clearCanvas();
  }

  private detachHostListeners(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.hostEl) {
      this.hostEl.removeEventListener("pointermove", this.onPointerMove);
      this.hostEl.removeEventListener("pointerleave", this.onPointerLeave);
    }
  }

  private probeColor(cssVarName: string, fallback: Rgb): Rgb {
    if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
      return fallback;
    }
    const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVarName).trim();
    if (!raw || !this.probeCtx) return fallback;
    const pCtx = this.probeCtx;
    pCtx.clearRect(0, 0, 1, 1);
    pCtx.fillStyle = "rgba(0, 0, 0, 0)";
    pCtx.fillStyle = raw;
    pCtx.fillRect(0, 0, 1, 1);
    const d = pCtx.getImageData(0, 0, 1, 1).data;
    if ((d[3] ?? 0) === 0) return fallback;
    return [d[0] ?? fallback[0], d[1] ?? fallback[1], d[2] ?? fallback[2]];
  }

  private ensureRunning(): void {
    if (this.destroyed || this.reducedMotion || this.rafId !== null) return;
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      return;
    }
    this.lastTime = performance.now();
    this.canvas.dataset.auroraRunning = "true";
    this.rafId = window.requestAnimationFrame(this.loop);
  }

  private stopLoop(): void {
    if (this.rafId !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    this.canvas.dataset.auroraRunning = "false";
  }

  private clearCanvas(): void {
    if (!this.ctx) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private triggerDissolve(): void {
    this.mode = "dissolving";
    this.dissolveTimer = 0.56;
    this.streaks = [];
    for (let i = 0; i < 28; i++) {
      const u = 0.08 + Math.random() * 0.84;
      const col = this.sampleColor(u, 0, this.paletteMix);
      const dir = u < 0.5 ? -1 : 1;
      this.streaks.push({
        x: u * this.width,
        y: this.height - 2 - Math.random() * 18,
        len: 14 + Math.random() * 52,
        vx: dir * (70 + Math.random() * 210),
        alpha: 0.55 + Math.random() * 0.45,
        h: Math.random() > 0.65 ? 2 : 1.3,
        color: Math.random() > 0.72 ? [this.coreColor[0], this.coreColor[1], this.coreColor[2]] : col,
      });
    }
  }

  private sampleStops(stops: Rgb[], t: number): Rgb {
    if (stops.length === 0) return this.coreColor;
    if (stops.length === 1) return stops[0]!;
    const wrapped = ((t % 1) + 1) % 1;
    const scaled = wrapped * (stops.length - 1);
    const i = Math.floor(scaled);
    const f = scaled - i;
    const a = stops[i]!;
    const b = stops[Math.min(i + 1, stops.length - 1)]!;
    return [
      a[0] + (b[0] - a[0]) * f,
      a[1] + (b[1] - a[1]) * f,
      a[2] + (b[2] - a[2]) * f,
    ];
  }

  private sampleColor(u: number, time: number, mix: number): Rgb {
    const cVoice = this.sampleStops(this.voiceStops, u * 1.1 - time * 0.085);
    const cThink = this.sampleStops(this.thinkStops, u * 1.25 - time * 0.16);
    return [
      cVoice[0] + (cThink[0] - cVoice[0]) * mix,
      cVoice[1] + (cThink[1] - cVoice[1]) * mix,
      cVoice[2] + (cThink[2] - cVoice[2]) * mix,
    ];
  }

  private hash(x: number, y: number, tick: number): number {
    let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(tick, 2147483647)) | 0;
    n = Math.imul(n ^ (n >> 13), 1274126177);
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
  }

  private spawnEmber(x: number, y: number, color: Rgb): void {
    if (this.embers.length >= 65) return;
    const life = 0.45 + Math.random() * 0.55;
    this.embers.push({
      x: x + (Math.random() - 0.5) * 6,
      y,
      vx: (Math.random() - 0.5) * 14,
      vy: -(16 + Math.random() * 34),
      life,
      maxLife: life,
      size: Math.random() > 0.5 ? 2.1 : 1.6,
      color,
    });
  }

  private stepFrame(now: number): void {
    this.rafId = null;
    if (this.destroyed || this.reducedMotion) {
      this.canvas.dataset.auroraRunning = "false";
      return;
    }

    const dt = Math.max(0, Math.min(0.05, (now - this.lastTime) / 1000));
    this.lastTime = now;
    const t = now / 1000;

    const targetIntensity =
      this.mode === "listening"
        ? 1
        : this.mode === "thinking"
          ? 0.88
          : this.mode === "loading"
            ? 0.78
            : 0;
    const speed = targetIntensity > this.intensity ? 7.5 : 5.5;
    this.intensity += (targetIntensity - this.intensity) * Math.min(1, dt * speed);

    const targetMix = this.mode === "thinking" || this.mode === "loading" ? 1 : 0;
    this.paletteMix += (targetMix - this.paletteMix) * Math.min(1, dt * 4.2);

    if (this.mode !== "listening") {
      this.voiceEnergy *= Math.pow(0.08, dt);
    }

    const ctx = this.ctx;
    if (ctx) {
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);

      if (this.intensity > 0.01) {
        this.renderAurora(ctx, t, false);
      }
      if (this.embers.length > 0) {
        this.renderEmbers(ctx, dt);
      }
      if (this.mode === "dissolving") {
        this.renderStreaks(ctx, dt);
      }

      ctx.restore();
    }

    // True Idle Sleep: stop rAF completely once fully quiescent
    if (
      this.mode === "idle" &&
      this.intensity < 0.005 &&
      this.embers.length === 0 &&
      this.streaks.length === 0
    ) {
      this.intensity = 0;
      this.voiceEnergy = 0;
      this.bands.fill(0);
      this.clearCanvas();
      this.canvas.dataset.auroraRunning = "false";
      return;
    }

    this.rafId = window.requestAnimationFrame(this.loop);
  }

  private renderStatic(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.mode === "idle" || this.mode === "dissolving") {
      this.clearCanvas();
      return;
    }

    this.intensity =
      this.mode === "listening" ? 0.9 : this.mode === "thinking" ? 0.82 : 0.78;
    this.paletteMix = this.mode === "thinking" || this.mode === "loading" ? 1 : 0;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this.renderAurora(ctx, 1.85, true);
    ctx.restore();
  }

  private renderUnderGlow(ctx: CanvasRenderingContext2D, t: number): void {
    // High-contrast mode renders crisp unblurred dots only
    if (this.theme === "high-contrast") return;

    const W = this.width;
    const H = this.height;
    const bloomH = (30 + this.voiceEnergy * 38) * this.intensity;
    if (bloomH <= 1) return;

    const isDark = this.theme === "dark";
    const loadingProg = Math.max(0.08, this.downloadProgress / 100);
    const segments = 32;
    const rx = Math.max(32, W * 0.13);

    ctx.save();
    ctx.globalCompositeOperation = isDark ? "lighter" : "source-over";

    // Sample every 2nd point along the 33-point bottom wave curve for smooth overlapping volumetric plumes
    // (zero ctx.filter blur — fast and identical across Chromium, Firefox, and WebKit)
    for (let i = 0; i <= segments; i += 2) {
      const u = i / segments;
      const edgeFade = Math.sin(u * Math.PI);
      if (edgeFade <= 0.01) continue;

      let loadGate = 1;
      if (this.mode === "loading") {
        const overflow = u - (loadingProg + 0.04);
        if (overflow > 0.14) continue;
        if (overflow > 0) loadGate = Math.max(0, 1 - overflow / 0.14);
      }

      const bell = Math.exp(-Math.pow((u - 0.5) * 2.3, 2));
      const wave = Math.sin(u * 9 - t * 3.1) * 0.25 + 0.75;
      const localH = Math.max(12, bloomH * (0.28 + 0.72 * bell) * wave * 1.48);

      const [r, g, b] = this.sampleColor(u, t, this.paletteMix);
      const basePeak = isDark
        ? (0.09 + this.voiceEnergy * 0.11) * this.intensity
        : (0.052 + this.voiceEnergy * 0.065) * this.intensity;
      const peakAlpha = basePeak * (0.3 + 0.7 * edgeFade) * loadGate;
      if (peakAlpha <= 0.003) continue;

      const cx = u * W;
      const cy = H + 3;
      const ri = r | 0;
      const gi = g | 0;
      const bi = b | 0;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(rx / localH, 1);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, localH);
      grad.addColorStop(0, `rgba(${ri}, ${gi}, ${bi}, ${peakAlpha.toFixed(3)})`);
      grad.addColorStop(0.4, `rgba(${ri}, ${gi}, ${bi}, ${(peakAlpha * 0.5).toFixed(3)})`);
      grad.addColorStop(0.75, `rgba(${ri}, ${gi}, ${bi}, ${(peakAlpha * 0.14).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${ri}, ${gi}, ${bi}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, localH, Math.PI, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  private renderAurora(ctx: CanvasRenderingContext2D, t: number, isStatic: boolean): void {
    const W = this.width;
    const H = this.height;
    const step = 4.0;
    const dotSize = 2.05;
    const cols = Math.floor(W / step);
    const rows = Math.floor((H - 1) / step);
    const tick = isStatic ? 1 : Math.floor(t * 12);

    // Pass 1: Volumetric Under-Glow
    if (!isStatic) {
      this.renderUnderGlow(ctx, t);
    }

    // Pass 2: Crisp Dot-Matrix Wave
    const coreR = this.coreColor[0];
    const coreG = this.coreColor[1];
    const coreB = this.coreColor[2];
    const isLight = this.theme === "light";
    const isHighContrast = this.theme === "high-contrast";

    for (let c = 0; c < cols; c++) {
      const x = c * step + 1.5;
      const u = (c + 0.5) / cols;

      if (this.mode === "loading") {
        const prog = Math.max(0.08, this.downloadProgress / 100);
        if (u > prog + 0.04) continue;
      }

      let colH: number;
      if (this.mode === "thinking") {
        const w1 = Math.sin(u * 9.5 - t * 3.8) * 0.5 + 0.5;
        const w2 = Math.sin(u * 16.0 + t * 2.6) * 0.5 + 0.5;
        const edge = Math.pow(Math.sin(u * Math.PI), 0.55);
        colH = (12 + (w1 * 15 + w2 * 8)) * edge;
      } else if (this.mode === "loading") {
        const prog = Math.max(0.08, this.downloadProgress / 100);
        const leadBoost = Math.exp(-Math.pow((u - prog) * 14, 2)) * 18;
        const ripple = (Math.sin(u * 14 - t * 4.2) * 0.5 + 0.5) * 10;
        colH = isStatic ? 12 + leadBoost * 0.6 : 9 + ripple + leadBoost;
        if (!isStatic && leadBoost > 10 && Math.random() < 0.09) {
          this.spawnEmber(x, H - colH, this.sampleColor(u, t, 1));
        }
      } else {
        const distCenter = Math.abs(u - 0.5) * 2;
        const bell = Math.exp(-Math.pow(distCenter * 1.48, 2));
        const bandIdx = Math.min(
          this.bands.length - 1,
          Math.floor(distCenter * (this.bands.length * 0.85)),
        );
        const fftVal = isStatic ? 0.15 : (this.bands[bandIdx] ?? 0);

        const w1 = Math.sin(u * 11 - t * 3.6) * 0.5 + 0.5;
        const w2 = Math.sin(u * 19 + t * 2.7) * 0.5 + 0.5;
        const w3 = Math.sin(u * 5.5 - t * 1.9) * 0.5 + 0.5;
        const organic = w1 * 0.45 + w2 * 0.3 + w3 * 0.25;

        const cursorDist = Math.abs(u - this.mouseU);
        const cursorLift = isStatic
          ? 0
          : this.mouseActive * Math.exp(-Math.pow(cursorDist * 9, 2)) * 18;

        const idleAlive = (7 + organic * 11) * (0.24 + 0.76 * bell);
        const energy = isStatic ? 0.18 : this.voiceEnergy;
        const voiceBoost =
          (energy * 38 + fftVal * 28) * (0.2 + 0.8 * bell) * (0.55 + 0.45 * organic);
        const edgeTaper = Math.pow(Math.sin(u * Math.PI), 0.62);

        colH = (idleAlive + voiceBoost + cursorLift) * edgeTaper;

        if (
          !isStatic &&
          ((colH > 32 && Math.random() < 0.022 * this.voiceEnergy) ||
            (cursorLift > 10 && Math.random() < 0.028))
        ) {
          this.spawnEmber(x, H - colH * this.intensity, this.sampleColor(u, t, this.paletteMix));
        }
      }

      colH *= this.intensity;
      const activeRows = Math.min(rows, Math.ceil((colH + step * 1.8) / step));
      if (activeRows <= 0) continue;

      const [cr, cg, cb] = this.sampleColor(u, t, this.paletteMix);

      for (let r = 0; r < activeRows; r++) {
        const y = H - (r + 1) * step + 0.5;
        const distFromBottom = (r + 0.5) * step;
        const ratio = distFromBottom / Math.max(1, colH);

        let alpha = 1;
        if (ratio > 0.62) {
          const n = this.hash(c, r, tick);
          const prob = 1 - (ratio - 0.62) / 0.56;
          if (n > prob) continue;
          alpha = Math.max(0.2, prob);
        }

        const centerBoost = Math.exp(-Math.pow((u - 0.5) * 2.2, 2));
        const rawCoreMix =
          Math.max(0, 1 - ratio * 2.25) *
          (0.45 + (isStatic ? 0.18 : this.voiceEnergy) * 0.38) *
          (0.55 + 0.45 * centerBoost);
        const coreMix = isLight ? rawCoreMix * 0.45 : isHighContrast ? rawCoreMix * 0.7 : rawCoreMix;

        const rr = (cr + (coreR - cr) * coreMix) | 0;
        const gg = (cg + (coreG - cg) * coreMix) | 0;
        const bb = (cb + (coreB - cb) * coreMix) | 0;

        const finalAlpha = Math.min(1, alpha * this.intensity * (0.98 - ratio * 0.22));
        ctx.fillStyle = `rgba(${rr}, ${gg}, ${bb}, ${finalAlpha.toFixed(3)})`;
        ctx.fillRect(x, y, dotSize, dotSize);
      }
    }
  }

  private renderEmbers(ctx: CanvasRenderingContext2D, dt: number): void {
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const p = this.embers[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        this.embers.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy *= Math.pow(0.45, dt);
      const a = Math.max(0, p.life / p.maxLife);
      const [r, g, b] = p.color;
      ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${(a * 0.9).toFixed(3)})`;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
  }

  private renderStreaks(ctx: CanvasRenderingContext2D, dt: number): void {
    this.dissolveTimer -= dt;
    const progress = Math.max(0, this.dissolveTimer / 0.56);

    ctx.save();
    ctx.globalCompositeOperation = this.theme === "dark" ? "lighter" : "source-over";
    for (const s of this.streaks) {
      s.x += s.vx * dt;
      s.vx *= Math.pow(0.22, dt);
      const a = s.alpha * progress;
      if (a <= 0.01) continue;
      const [r, g, b] = s.color;
      const ri = r | 0;
      const gi = g | 0;
      const bi = b | 0;
      const grad = ctx.createLinearGradient(s.x - s.len / 2, s.y, s.x + s.len / 2, s.y);
      grad.addColorStop(0, `rgba(${ri}, ${gi}, ${bi}, 0)`);
      grad.addColorStop(0.5, `rgba(${ri}, ${gi}, ${bi}, ${a.toFixed(3)})`);
      grad.addColorStop(1, `rgba(${ri}, ${gi}, ${bi}, 0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(s.x - s.len / 2, s.y, s.len, s.h);
    }
    ctx.restore();

    if (this.dissolveTimer <= 0) {
      this.streaks = [];
      this.mode = "idle";
    }
  }
}
