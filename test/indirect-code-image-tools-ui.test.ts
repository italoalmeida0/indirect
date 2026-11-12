import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import { transformAsync } from "@babel/core";
import tsPreset from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";
import { createRoot } from "solid-js";
import type { CompactionState, ToolUnit } from "../web/src/indirect-code/types";
import { useToolUnitModel } from "../web/src/indirect-code/components/tool/toolUnitModel";
import type { resolveCompactionViewModel as ResolveCompactionViewModelFn } from "../web/src/indirect-code/components/CompactionBalloon";
import {
  formatImageBytes,
  formatImageMimeLabel,
  isImageReadPath,
  parseImageReadDetails,
  toolSummary,
} from "../web/src/indirect-code/transcript";

const SAMPLE_PREVIEW_DATA_URL =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

function mkReadUnit(
  args: Record<string, unknown>,
  result?: { text?: string; details?: Record<string, unknown>; isError?: boolean },
): ToolUnit {
  return {
    id: "id_read_img",
    call: {
      type: "tool_call",
      toolId: "id_read_img",
      toolName: "read",
      toolArgs: JSON.stringify(args),
    },
    ...(result
      ? {
          result: {
            type: "tool_result",
            toolId: "id_read_img",
            toolResult: result.text ?? "",
            ...(result.details ? { toolDetails: result.details } : {}),
            ...(result.isError ? { isError: true } : {}),
          },
        }
      : {}),
  };
}

describe("Image read detection, formatting, and toolSummary", () => {
  test("recognizes image extensions and formats byte sizes and MIME labels cleanly", () => {
    for (const p of [
      "screenshot.png",
      "docs/hero.JPG",
      "photo.jpeg",
      "anim.gif",
      "ui/card.webp",
      "C:\\captures\\frame.BMP",
    ]) {
      expect(isImageReadPath(p)).toBe(true);
    }
    for (const p of ["server.ts", "README.md", "image.svg", "video.mp4", ""]) {
      expect(isImageReadPath(p)).toBe(false);
    }

    expect(formatImageMimeLabel("image/jpeg")).toBe("JPEG");
    expect(formatImageMimeLabel("image/jpg")).toBe("JPEG");
    expect(formatImageMimeLabel("image/png")).toBe("PNG");
    expect(formatImageMimeLabel("image/webp")).toBe("WEBP");
    expect(formatImageMimeLabel("image/gif")).toBe("GIF");
    expect(formatImageMimeLabel("image/bmp")).toBe("BMP");

    expect(formatImageBytes(512)).toBe("512 B");
    expect(formatImageBytes(2560)).toBe("2.5 KB");
    expect(formatImageBytes(145210)).toBe("142 KB");
    expect(formatImageBytes(4821900)).toBe("4.6 MB");
  });

  test("toolSummary uses lucide:image, omits #L1-2 line ranges, and formats concise stats across all image read states", () => {
    // 1. Running / pending image read before result arrives
    expect(toolSummary(mkReadUnit({ path: "docs/dashboard-4k.png" }))).toEqual({
      icon: "lucide:image",
      verb: "Analyzed",
      target: "dashboard-4k.png",
    });

    // 2. Live resized + converted image read with numeric toolDetails
    expect(
      toolSummary(
        mkReadUnit(
          { path: "docs/dashboard-4k.png" },
          {
            text: "Read image file [image/jpeg]\n[Image resized from 3840x2160 to 1568x882]",
            details: {
              path: "docs/dashboard-4k.png",
              media: "image/jpeg",
              orig_media: "image/png",
              width: 1568,
              height: 882,
              orig_width: 3840,
              orig_height: 2160,
              bytes: 145210,
              orig_bytes: 4821900,
              preview_data_url: SAMPLE_PREVIEW_DATA_URL,
            },
          },
        ),
      ),
    ).toEqual({
      icon: "lucide:image",
      verb: "Analyzed",
      target: "dashboard-4k.png",
      stat: "1568×882 · 142 KB",
    });

    // 3. WAL-reloaded envelope with string attributes and no transient toolDetails
    const walEnvelope =
      `<tool_result type="ok" media="image/jpeg" orig_media="image/png" ` +
      `width="1568" height="882" orig_width="3840" orig_height="2160" ` +
      `bytes="145210" orig_bytes="4821900" sha256="a1b2c3d4e5f60718">` +
      `Read image file [image/jpeg]\n[Image resized from 3840x2160 to 1568x882]</tool_result>`;
    expect(toolSummary(mkReadUnit({ path: "docs/dashboard-4k.png" }, { text: walEnvelope }))).toEqual({
      icon: "lucide:image",
      verb: "Analyzed",
      target: "dashboard-4k.png",
      stat: "1568×882 · 142 KB",
    });

    // 4. Legacy resized hint without byte attributes -> dimensions transition stat
    expect(
      toolSummary(
        mkReadUnit(
          { path: "captures/wide.png" },
          { text: "Read image file [image/jpeg]\n[Image resized from 3840x2160 to 1568x882]" },
        ),
      ),
    ).toEqual({
      icon: "lucide:image",
      verb: "Analyzed",
      target: "wide.png",
      stat: "3840×2160 → 1568×882",
    });

    // 5. Legacy minimal text-only image read -> format label fallback
    expect(
      toolSummary(
        mkReadUnit({ path: "assets/icon.png" }, { text: "Read image file [image/png]" }),
      ),
    ).toEqual({
      icon: "lucide:image",
      verb: "Analyzed",
      target: "icon.png",
      stat: "PNG",
    });

    // 6. Error reading an image path -> keeps image icon + filename without fake #L1-1 or fake stats
    expect(
      toolSummary(
        mkReadUnit(
          { path: "assets/missing.webp" },
          {
            text: `<tool_result type="error">open assets/missing.webp: file does not exist</tool_result>`,
            isError: true,
          },
        ),
      ),
    ).toEqual({
      icon: "lucide:image",
      verb: "Analyzed",
      target: "missing.webp",
    });

    // 7. Paginated text file that mentions "Read image file [image/png]" stays a text read with #L range
    expect(
      toolSummary(
        mkReadUnit(
          { path: "packages/agent/tools/read.go", offset: 85, limit: 10 },
          {
            text: `<tool_result type="ok" page="85-94/378">Read image file [image/png]</tool_result>`,
            details: { start_line: 85, total_lines: 378 },
          },
        ),
      ),
    ).toEqual({
      icon: "lucide:file-text",
      verb: "Analyzed",
      target: "read.go#L85-94",
    });
  });
});

describe("useToolUnitModel.imageReadDetails & WAL durability", () => {
  function evalModel(unit: ToolUnit, running = false, active = false) {
    return createRoot((dispose) => {
      const ctx: any = {
        toolProgress: () => ({}),
        toolStarts: () => ({}),
        turnClock: () => 0,
        bgClock: () => 0,
        backgroundJobs: () => [],
        bgOutput: () => ({}),
        elapsedLabel: () => "",
        cancelBgJob: () => {},
        openFile: () => {},
      };
      const m = useToolUnitModel(ctx, "msg_img", unit, 0, () => running, () => active);
      const snap = {
        info: m.imageReadDetails(),
        hasContent: m.hasContent(),
        sum: m.sum(),
      };
      dispose();
      return snap;
    });
  }

  test("extracts full live metadata, WAL-reloaded empty-body attrs, legacy coordinate hints, and rejects unsafe preview URLs", () => {
    // Live resized + converted
    const live = evalModel(
      mkReadUnit(
        { path: "screens/checkout.png" },
        {
          text: "Read image file [image/jpeg]\n[Image resized from 3840x2160 to 1568x882]",
          details: {
            path: "screens/checkout.png",
            media: "image/jpeg",
            orig_media: "image/png",
            width: 1568,
            height: 882,
            orig_width: 3840,
            orig_height: 2160,
            bytes: 145210,
            orig_bytes: 4821900,
            sha256: "0123456789abcdef",
            preview_data_url: SAMPLE_PREVIEW_DATA_URL,
          },
        },
      ),
    );
    expect(live.hasContent).toBe(true);
    expect(live.info).toEqual({
      path: "screens/checkout.png",
      media: "image/jpeg",
      origMedia: "image/png",
      formatLabel: "JPEG",
      origFormatLabel: "PNG",
      width: 1568,
      height: 882,
      origWidth: 3840,
      origHeight: 2160,
      resized: true,
      converted: true,
      bytes: 145210,
      origBytes: 4821900,
      sha256: "0123456789abcdef",
      previewDataUrl: SAMPLE_PREVIEW_DATA_URL,
      hints: [],
    });

    // WAL-reloaded with empty body and empty args still reports hasContent === true from mergedEnv.media
    const walEmptyBodyUnit: ToolUnit = {
      id: "wal_empty",
      call: { type: "tool_call", toolId: "wal_empty", toolName: "read", toolArgs: "{}" },
      result: {
        type: "tool_result",
        toolId: "wal_empty",
        toolResult: `<tool_result type="ok" path="ui/empty-body.webp" media="image/webp" width="800" height="600" bytes="32768"></tool_result>`,
      },
    };
    const walEmpty = evalModel(walEmptyBodyUnit);
    expect(walEmpty.hasContent).toBe(true);
    expect(walEmpty.info?.media).toBe("image/webp");
    expect(walEmpty.info?.width).toBe(800);
    expect(walEmpty.info?.height).toBe(600);
    expect(walEmpty.info?.bytes).toBe(32768);
    expect(walEmpty.info?.previewDataUrl).toBeUndefined();

    // Legacy coordinate mapping hint + unsafe preview URL filtering
    const legacyParsed = parseImageReadDetails({
      args: { path: "old/frame.bmp" },
      output:
        "Read image file [image/png]\n" +
        "[Image converted from image/bmp to image/png.]\n" +
        "[Image: original 3000x2000, displayed at 1500x1000. Multiply coordinates by 2.00 to map to original image.]",
      details: { preview_data_url: "https://evil.example.com/pixel.png" },
      hasResult: true,
      isError: false,
    });
    expect(legacyParsed?.converted).toBe(true);
    expect(legacyParsed?.origFormatLabel).toBe("BMP");
    expect(legacyParsed?.formatLabel).toBe("PNG");
    expect(legacyParsed?.resized).toBe(true);
    expect(legacyParsed?.origWidth).toBe(3000);
    expect(legacyParsed?.width).toBe(1500);
    expect(legacyParsed?.previewDataUrl).toBeUndefined();
    expect(legacyParsed?.hints).toEqual([
      "Multiply coordinates by 2.00 to map to original image.",
    ]);

    // Error state and non-image read return undefined
    const errored = evalModel(
      mkReadUnit({ path: "screens/broken.png" }, { text: "file exceeds 50 MB limit", isError: true }),
    );
    expect(errored.info).toBeUndefined();

    const textRead = evalModel(
      mkReadUnit({ path: "src/index.ts" }, { text: "1:export const x = 1;" }),
    );
    expect(textRead.info).toBeUndefined();
  });
});

describe("SSR <ToolBody> ImageReadCard & <CompactionBalloon> visual digest chip", () => {
  let renderToolBodySsr!: (
    u: ToolUnit,
    opts: { running: boolean; active: boolean },
  ) => string;
  let renderCompactionBalloonSsr!: (compaction?: CompactionState | null) => string;
  let resolveCompactionViewModel!: typeof ResolveCompactionViewModelFn;

  beforeAll(async () => {
    const compDir = join(process.cwd(), "web", "src", "indirect-code", "components");
    const virtualEntryPath = join(compDir, "__ssr_image_ui_entry__.tsx");

    const buildRes = await Bun.build({
      entrypoints: [virtualEntryPath],
      target: "bun",
      format: "esm",
      external: ["solid-js", "solid-js/web", "highlight.js", "katex"],
      plugins: [
        {
          name: "image-ui-ssr-test-plugin",
          setup(build) {
            build.onResolve({ filter: /__ssr_image_ui_entry__\.tsx$/ }, () => ({
              path: virtualEntryPath,
            }));
            build.onLoad({ filter: /__ssr_image_ui_entry__\.tsx$/ }, async () => {
              const entryCode = `
                import { renderToString } from "solid-js/web";
                import { ToolBody } from "./tool/ToolBody";
                import { useToolUnitModel } from "./tool/toolUnitModel";
                import { CompactionBalloon, resolveCompactionViewModel } from "./CompactionBalloon";
                export { resolveCompactionViewModel };

                export function renderToolBodySsr(u, opts) {
                  const ctx = {
                    toolProgress: () => ({}),
                    toolStarts: () => ({}),
                    turnClock: () => 0,
                    bgClock: () => 0,
                    backgroundJobs: () => [],
                    bgOutput: () => ({}),
                    elapsedLabel: () => "",
                    pendingApproval: () => null,
                    pendingQuestion: () => null,
                    cancelBgJob: () => {},
                    openFile: () => {},
                  };
                  return renderToString(() => {
                    const m = useToolUnitModel(ctx, "msg_ssr_img", u, 0, () => opts.running, () => opts.active);
                    return <ToolBody ctx={ctx} msgId="msg_ssr_img" u={u} m={m} running={opts.running} active={opts.active} />;
                  });
                }

                export function renderCompactionBalloonSsr(compaction) {
                  return renderToString(() => <CompactionBalloon compaction={compaction} />);
                }
              `;
              const transformed = await transformAsync(entryCode, {
                filename: virtualEntryPath,
                presets: [[solidPreset, { generate: "ssr", hydratable: false }]],
                babelrc: false,
                configFile: false,
              });
              return { contents: transformed?.code ?? entryCode, loader: "js" };
            });

            build.onResolve({ filter: /^virtual:icons$/ }, () => ({
              path: "virtual:icons",
              namespace: "virtual-icons",
            }));
            build.onLoad({ filter: /.*/, namespace: "virtual-icons" }, () => ({
              contents: "export const registry = {}; export const icons = {}; export default registry;",
              loader: "js",
            }));

            build.onLoad({ filter: /\.css$/ }, () => ({
              contents: "",
              loader: "js",
            }));

            build.onLoad({ filter: /web[\\/]src[\\/]ui\.tsx$/ }, () => ({
              contents: "export async function copyWithToast() { return false; }",
              loader: "js",
            }));

            build.onLoad({ filter: /TarnavMarkdown\.tsx$/ }, async (args) => {
              const ssrStub = `
                export function TarnavMarkdown(props: { children: string; noNestedScroll?: boolean }) {
                  return <div>{props.children}</div>;
                }
              `;
              const out = await transformAsync(ssrStub, {
                filename: args.path,
                presets: [
                  [solidPreset, { generate: "ssr", hydratable: false }],
                  [tsPreset, { isTSX: true, allExtensions: true }],
                ],
                babelrc: false,
                configFile: false,
              });
              return { contents: out?.code ?? ssrStub, loader: "js" };
            });

            build.onLoad({ filter: /\.(js|ts)x$/ }, async (args) => {
              if (
                args.path.endsWith("__ssr_image_ui_entry__.tsx") ||
                args.path.endsWith("TarnavMarkdown.tsx") ||
                /[\\/]web[\\/]src[\\/]ui\.tsx$/.test(args.path)
              ) {
                return undefined;
              }
              const code = await readFile(args.path, "utf8");
              const out = await transformAsync(code, {
                filename: args.path,
                presets: [
                  [solidPreset, { generate: "ssr", hydratable: false }],
                  [tsPreset, { isTSX: true, allExtensions: true }],
                ],
                sourceMaps: false,
                babelrc: false,
                configFile: false,
              });
              return { contents: out?.code ?? code, loader: "js" };
            });
          },
        },
      ],
    });

    if (!buildRes.success || buildRes.outputs.length === 0) {
      throw new Error(`Failed to bundle SSR image UI harness: ${JSON.stringify(buildRes.logs)}`);
    }
    const jsText = await buildRes.outputs[0]!.text();
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(jsText, "utf8").toString("base64")}`
    );
    renderToolBodySsr = mod.renderToolBodySsr;
    renderCompactionBalloonSsr = mod.renderCompactionBalloonSsr;
    resolveCompactionViewModel = mod.resolveCompactionViewModel;
  });

  test("renders live resized+converted ImageReadCard with thumbnail, savings badge, and zero CodeBlock or nested scrollbars", () => {
    const html = renderToolBodySsr(
      mkReadUnit(
        { path: "screenshots/hero-4k.png" },
        {
          text: "Read image file [image/jpeg]\n[Image resized from 3840x2160 to 1568x882]",
          details: {
            path: "screenshots/hero-4k.png",
            media: "image/jpeg",
            orig_media: "image/png",
            width: 1568,
            height: 882,
            orig_width: 3840,
            orig_height: 2160,
            bytes: 145210,
            orig_bytes: 4821900,
            preview_data_url: SAMPLE_PREVIEW_DATA_URL,
          },
        },
      ),
      { running: false, active: false },
    );

    expect(html).toContain("data-tool-image-read");
    expect(html).toContain("data-image-preview");
    expect(html).toContain(`src="${SAMPLE_PREVIEW_DATA_URL}"`);
    expect(html).toContain("max-h-44");
    expect(html).not.toContain("data-image-icon-tile");
    expect(html).toContain("hero-4k.png");
    expect(html).toContain("PNG → JPEG");
    expect(html).toContain("3840×2160 → 1568×882 px");
    expect(html).toContain("4.6 MB → 142 KB");
    expect(html).toContain("data-image-savings-badge");
    expect(html).toContain("-97%");
    // Never renders numbered CodeBlock for image reads
    expect(html).not.toContain("rc-code");
    expect(html).not.toContain("Read image file [image/jpeg]");
    // Single scroll surface: inner card has zero nested overflow-auto/scroll
    const innerCard = html.slice(html.indexOf("data-tool-image-read"));
    expect(innerCard).not.toMatch(/\boverflow-(?:auto|scroll|x-auto|y-auto|x-scroll|y-scroll)\b/);
  });

  test("renders small passthrough ImageReadCard without conversion arrow or savings badge", () => {
    const html = renderToolBodySsr(
      mkReadUnit(
        { path: "assets/badge.png" },
        {
          text: "Read image file [image/png]",
          details: {
            path: "assets/badge.png",
            media: "image/png",
            orig_media: "image/png",
            width: 320,
            height: 180,
            orig_width: 320,
            orig_height: 180,
            bytes: 18432,
            orig_bytes: 18432,
            preview_data_url: SAMPLE_PREVIEW_DATA_URL,
          },
        },
      ),
      { running: false, active: false },
    );

    expect(html).toContain("data-tool-image-read");
    expect(html).toContain("badge.png");
    expect(html).toContain(">PNG<");
    expect(html).toContain("320×180 px");
    expect(html).toContain("18 KB");
    expect(html).not.toContain("→");
    expect(html).not.toContain("data-image-savings-badge");
  });

  test("renders WAL-reloaded attrs-only ImageReadCard with crisp icon tile and zero broken <img>", () => {
    const walText =
      `<tool_result type="ok" media="image/jpeg" orig_media="image/png" ` +
      `width="1568" height="882" orig_width="3840" orig_height="2160" ` +
      `bytes="145210" orig_bytes="4821900" sha256="deadbeefcafebabe">` +
      `Read image file [image/jpeg]\n[Image resized from 3840x2160 to 1568x882]</tool_result>`;
    const html = renderToolBodySsr(
      mkReadUnit({ path: "screenshots/reloaded.png" }, { text: walText }),
      { running: false, active: false },
    );

    expect(html).toContain("data-tool-image-read");
    expect(html).toContain("data-image-icon-tile");
    expect(html).not.toContain("<img");
    expect(html).toContain("reloaded.png");
    expect(html).toContain("PNG → JPEG");
    expect(html).toContain("3840×2160 → 1568×882 px");
    expect(html).toContain("4.6 MB → 142 KB");
    expect(html).toContain("-97%");
  });

  test("renders legacy text-only image read and surfaces non-redundant daemon hints cleanly", () => {
    const htmlPlain = renderToolBodySsr(
      mkReadUnit({ path: "legacy/diagram.png" }, { text: "Read image file [image/png]" }),
      { running: false, active: false },
    );
    expect(htmlPlain).toContain("data-tool-image-read");
    expect(htmlPlain).toContain("data-image-icon-tile");
    expect(htmlPlain).not.toContain("<img");
    expect(htmlPlain).toContain("diagram.png");
    expect(htmlPlain).toContain(">PNG<");
    expect(htmlPlain).not.toContain("rc-code");

    const htmlWithHint = renderToolBodySsr(
      mkReadUnit(
        { path: "legacy/unsupported.webp" },
        {
          text: "Read image file [image/webp]\n[Image omitted: could not be converted to a supported inline image format.]",
        },
      ),
      { running: false, active: false },
    );
    expect(htmlWithHint).toContain("data-tool-image-read");
    expect(htmlWithHint).toContain("WEBP");
    expect(htmlWithHint).toContain(
      "Image omitted: could not be converted to a supported inline image format.",
    );
  });

  test("renders running, incomplete, and error states cleanly for image paths", () => {
    const htmlRunning = renderToolBodySsr(mkReadUnit({ path: "ui/live-shot.webp" }), {
      running: true,
      active: true,
    });
    expect(htmlRunning).toContain("data-tool-image-read");
    expect(htmlRunning).toContain("live-shot.webp");
    expect(htmlRunning).toContain("WEBP");
    expect(htmlRunning).toContain("Inspecting image…");

    const htmlIncomplete = renderToolBodySsr(mkReadUnit({ path: "ui/live-shot.webp" }), {
      running: false,
      active: false,
    });
    expect(htmlIncomplete).toContain("data-tool-image-read");
    expect(htmlIncomplete).toContain("Image read did not complete.");

    const htmlError = renderToolBodySsr(
      mkReadUnit(
        { path: "ui/oversize.png" },
        {
          text: `<tool_result type="error">image file ui/oversize.png exceeds 50 MB limit</tool_result>`,
          isError: true,
        },
      ),
      { running: false, active: false },
    );
    expect(htmlError).not.toContain("data-tool-image-read");
    expect(htmlError).toContain("image file ui/oversize.png exceeds 50 MB limit");
    expect(htmlError).toContain("text-danger");
  });

  test("CompactionBalloon renders semantic visual digest chip when imageDigests or evictedImages exist and omits it when absent", () => {
    const emptyState: CompactionState = {
      previousSummary: "## Goal\nText-only session.",
      count: 1,
      keepFrom: 10,
    };
    expect(resolveCompactionViewModel(emptyState).visualDigestCount).toBe(0);
    const htmlEmpty = renderCompactionBalloonSsr(emptyState);
    expect(htmlEmpty).not.toContain("data-compaction-visual-digests");
    expect(htmlEmpty).not.toContain("visual digest");

    const singleDigestState: CompactionState = {
      previousSummary: "## Goal\nInspected login screenshot.",
      count: 1,
      keepFrom: 8,
      imageDigests: {
        sha_login: "- Login form with 401 Invalid token banner",
      },
    };
    expect(resolveCompactionViewModel(singleDigestState).visualDigestCount).toBe(1);
    const htmlSingle = renderCompactionBalloonSsr(singleDigestState);
    expect(htmlSingle).toContain("data-compaction-visual-digests");
    expect(htmlSingle).toContain("1 visual digest cached");

    const multiDigestState: CompactionState = {
      previousSummary: "## Goal\nMulti-image audit.",
      count: 3,
      keepFrom: 24,
      imageDigests: {
        sha_1: "Digest 1",
        sha_2: "Digest 2",
        sha_3: "Digest 3",
        sha_4: "Digest 4",
      },
      evictedImages: {
        "2:0:sha_1": true,
        "4:0:sha_2": true,
      },
      learnedMaxImages: 2,
    };
    const multiVm = resolveCompactionViewModel(multiDigestState);
    expect(multiVm.visualDigestCount).toBe(4);
    expect(multiVm.evictedImageCount).toBe(2);
    expect(multiVm.learnedMaxImages).toBe(2);
    const htmlMulti = renderCompactionBalloonSsr(multiDigestState);
    expect(htmlMulti).toContain("data-compaction-visual-digests");
    expect(htmlMulti).toContain("4 visual digests cached");
    expect(htmlMulti).toContain("wire cap: 2 images");

    const evictedOnlyState: CompactionState = {
      previousSummary: "## Goal\nShed wire images.",
      evictedImages: {
        "1:0:a": true,
        "3:0:b": true,
      },
      learnedMaxImages: 0,
    };
    expect(resolveCompactionViewModel(evictedOnlyState).visualDigestCount).toBe(2);
    const htmlEvicted = renderCompactionBalloonSsr(evictedOnlyState);
    expect(htmlEvicted).toContain("2 visual digests cached");
    expect(htmlEvicted).toContain("text-only");
  });
});
