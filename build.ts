process.env.NODE_ENV = "production";

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync as readFileSyncImpl,
  rmSync,
  writeFileSync as writeFileSyncImpl,
} from "fs";
import path from "path";
import { fileURLToPath } from "url";

import tailwindPlugin from "./plugins/tailwind-plugin";
import solidPlugin from "./plugins/solid-plugin";
import iconifyPlugin from "./plugins/iconify-solid-plugin";
import { vendorGenUiLibs } from "./scripts/vendor-gen-ui-libs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(ROOT, "dist");

/** Static import closure of the entry chunk (never the lazy route chunks):
 *  exactly what a first paint needs. */
function entryStaticChunks(dir: string, entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    let source: string;
    try {
      source = readFileSyncImpl(path.join(dir, file), "utf8");
    } catch {
      return;
    }
    // STATIC imports only (`from "./x.js"` and bare side-effect imports).
    // `import("./x.js")` is a lazy route chunk and must stay off the preload
    // list, or the split ships anyway.
    for (const match of source.matchAll(/(?:(?:^|[;}\s])import\s*["']|from\s*["'])\.\/([^"']+\.js)["']/g)) {
      walk(match[1]!);
    }
  };
  walk(entry);
  return [...seen];
}

async function build() {
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  console.log("[build] Bundling dashboard SPA...");
  // Entry is the SCRIPT, not index.html. Bun's HTML entrypoint with
  // `splitting: true` emits an entry chunk that does not contain the module
  // the script tag pointed at (the document ended up booting an unrelated
  // shared chunk and the app never mounted). A JS entry produces a stable
  // `index.js` plus per-route chunks; the HTML shell is assembled below with
  // the hashed CSS/JS names injected.
  const result = await Bun.build({
    entrypoints: [path.join(ROOT, "web", "src", "boot.tsx")],
    outdir: path.join(distDir, "assets"),
    target: "browser",
    minify: true,
    // Route-level `lazy(() => import(...))` only becomes a separate request
    // when the bundler is allowed to split; without this every route ships in
    // the entry chunk and the split is a no-op.
    splitting: true,
    // Every output is content-addressed. A FIXED entry name collides with the
    // CSS that is emitted alongside it (same base name, different extension),
    // so the entry is hashed too and resolved from result.outputs below.
    naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    // No source maps in the published bundle: dist/ is served to the public
    // internet; a linked .map would expose the whole frontend source.
    sourcemap: "none",
    plugins: [iconifyPlugin, tailwindPlugin, solidPlugin],
  });

  if (!result.success) {
    console.error("[build] failed:");
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const emitted = result.outputs.map((output) => path.basename(output.path));

  const assetPath = (file: string) => `/assets/${path.basename(file)}`;
  const emittedEntry = result.outputs.find((output) => output.kind === "entry-point");
  const emittedStyle =
    result.outputs.find(
      (output) => output.kind === "asset" && /^boot-[^/\\]+\.css$/.test(path.basename(output.path)),
    ) ?? result.outputs.find((output) => output.kind === "asset" && output.path.endsWith(".css"));
  if (!emittedEntry) {
    console.error(`[build] no JavaScript entry was produced (saw: ${emitted.slice(0, 12).join(", ")})`);
    process.exit(1);
  }
  if (!emittedStyle) {
    console.error("[build] no stylesheet was produced");
    process.exit(1);
  }
  const entryFile = path.basename(emittedEntry.path);
  const styleFile = path.basename(emittedStyle.path);
  // Every chunk the entry statically imports is needed for first paint; ask
  // the browser to fetch them in parallel with the entry instead of after it.
  const preload = entryStaticChunks(path.join(distDir, "assets"), entryFile).map(assetPath);

  // Assemble the document from the source shell: the hashed bundle names are
  // only known after the build, and the inline pre-paint scripts must survive
  // byte-for-byte (their sha256 hashes are pinned in the CSP).
  {
    const sourceHtml = readFileSyncImpl(path.join(ROOT, "web", "index.html"), "utf8");
    const withoutAssets = sourceHtml
      .replace(/\s*<link rel="stylesheet" href="\.\/style\.tailwindcss\.css" \/>/, "")
      .replace(/\s*<script type="module" src="\.\/src\/index\.tsx"><\/script>/, "");
    if (withoutAssets === sourceHtml) {
      console.error("[build] index.html no longer matches the expected asset tags");
      process.exit(1);
    }
    const head = [
      `<link rel="stylesheet" crossorigin href="${assetPath(styleFile)}" />`,
      ...preload.map((href) => `<link rel="modulepreload" crossorigin href="${href}" />`),
      `<script type="module" crossorigin src="${assetPath(entryFile)}"></script>`,
    ].join("\n    ");
    const document = withoutAssets.replace("</head>", `    ${head}\n  </head>`);
    if (!document.includes(assetPath(entryFile)) || !document.includes(assetPath(styleFile))) {
      console.error("[build] could not inject the built assets into index.html");
      process.exit(1);
    }
    writeFileSyncImpl(path.join(distDir, "index.html"), document);
  }

  // History normalize worker (standalone, outside the SPA bundle): the
  // transcript instantiates it via a static URL so large history blocks
  // parse off the main thread.
  console.log("[build] Bundling history worker...");
  const workerResult = await Bun.build({
    entrypoints: [path.join(ROOT, "web", "src", "indirect-code", "transcript", "history-worker.ts")],
    outdir: path.join(distDir, "workers"),
    target: "browser",
    minify: true,
    sourcemap: "none",
    plugins: [solidPlugin],
  });
  if (!workerResult.success) {
    console.error("[build] worker failed:");
    for (const log of workerResult.logs) console.error(log);
    process.exit(1);
  }

  // Generative UI sandbox libraries (d3, gsap, chart.js, three...) inlined
  // into widget frames.
  console.log("[build] Vendoring generative UI sandbox libraries...");
  await vendorGenUiLibs();
  // Static legal pages + any other public assets (served as-is by the backend).
  if (existsSync(path.join(ROOT, "web", "public"))) {
    cpSync(path.join(ROOT, "web", "public"), distDir, { recursive: true });
  }
  // Daemon releases into dist/r/ (public static: <gateway>/r/...).
  // Gateway-first updates/installs with zero new endpoints — static.ts
  // already hardens traversal/MIME/cache. No GitHub dependency.
  {
    const staged = path.join(ROOT, "web", "public", "r");
    const daemonDist = path.join(ROOT, "indirect-code-daemon", "dist");
    const dest = path.join(distDir, "r");
    mkdirSync(dest, { recursive: true });

    let rCount = 0;
    const copied = new Set<string>();

    if (existsSync(staged)) {
      for (const f of readdirSync(staged)) {
        if (/^(indirect-(code|launcher)-|versions\.json|SHA256SUMS\.txt|indirect-code-install\.)/.test(f)) {
          cpSync(path.join(staged, f), path.join(dest, f));
          copied.add(f);
          rCount++;
        }
      }
    }

    if (existsSync(daemonDist)) {
      for (const f of readdirSync(daemonDist)) {
        if (!copied.has(f) && /^(indirect-(code|launcher)-|versions\.json|SHA256SUMS\.txt|indirect-code-install\.)/.test(f)) {
          cpSync(path.join(daemonDist, f), path.join(dest, f));
          rCount++;
        }
      }
    }

    if (rCount > 0) {
      console.log(`[build] daemon releases -> dist/r/ (${rCount} files)`);
    }
  }

  // Web Push Service Worker (vanilla, outside the bundle): must be served
  // from the site root so its scope covers the whole dashboard.
  const swSrc = path.join(ROOT, "web", "push-sw.js");
  if (existsSync(swSrc)) {
    cpSync(swSrc, path.join(distDir, "push-sw.js"));
    console.log("[build] push-sw.js -> dist/ (turn-end push for closed tabs)");
  }

  // PWA install surface: Bun's HTML bundler resolves <link href> as build
  // inputs, so the manifest/apple-touch links live behind a <!--PWA-HEAD-->
  // placeholder in web/index.html and are injected here (same absolute
  // paths the dev server serves from web/public/).
  {
    const { readFileSync, writeFileSync } = await import("fs");
    const distHtml = path.join(distDir, "index.html");
    const pwaHead = [
      '<link rel="manifest" href="/manifest.webmanifest" />',
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />',
    ].join("\n    ");
    const html = readFileSync(distHtml, "utf-8");
    if (!html.includes("<!--PWA-HEAD-->")) {
      console.error("[build] PWA placeholder missing in dist/index.html");
      process.exit(1);
    }
    writeFileSync(distHtml, html.replace("<!--PWA-HEAD-->", pwaHead));
    console.log("[build] PWA head injected into dist/index.html");
  }

  // The versioned public asset is copied above, including in clean CI builds.
  if (!existsSync(path.join(distDir, "pandoc.wasm"))) {
    throw new Error("Missing web/public/pandoc.wasm: office conversion cannot be deployed");
  }
  console.log("[build] pandoc.wasm -> dist/ (office conversion enabled)");

  console.log(`[build] OK -> dist/ (${result.outputs.length} outputs)`);
  process.exit(0);
}

build();
