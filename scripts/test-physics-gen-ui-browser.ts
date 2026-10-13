/**
 * Test generative UI physics libraries in a real Chromium browser.
 *
 * Verifies that AI markdown answers with ```generative_ui blocks using:
 *  1) 2D rigid-body physics via `matter-js`
 *  2) 3D rigid-body physics via `three` + `cannon-es`
 * parse, compile, mount, step their physics simulations, and handle UI controls
 * inside real sandboxed iframes without errors.
 */

process.env.GATEWAY_SECRET =
  process.env.GATEWAY_SECRET ||
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DATA_DIR = process.env.DATA_DIR || "./data/test";

import { mkdirSync } from "fs";
import path from "path";
import assert from "assert";

import {
  parseGenerativeUiDsl,
  splitGenerativeUiSegments,
} from "../web/src/indirect-code/components/generative-ui/dsl";
import { handleGenUiRoute } from "../server/routes/gen-ui";
import { vendorGenUiLibs } from "./vendor-gen-ui-libs";

const PW_PATH = process.env.PLAYWRIGHT_MODULE || "/tmp/pw/node_modules/playwright-core/index.mjs";
const CHROME_PATH =
  process.env.CHROMIUM_PATH ||
  "/home/user/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const { chromium } = await import(PW_PATH);

const SHOTS_DIR = path.resolve(
  "/home/user/.gemini/antigravity-cli/brain/999fdc93-d6e1-4a1f-b3ba-4258cff11d55/shots",
);
mkdirSync(SHOTS_DIR, { recursive: true });

// Ensure vendored libraries are built
await vendorGenUiLibs();

// Start a local test HTTP server to serve gen-ui routes + iframe host page
const PORT = 4789;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const hostedIframes: Record<string, string> = {};

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Ignore favicon requests
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });

    // Gen-ui route handlers
    const genUiRes = await handleGenUiRoute(url.pathname, req, url);
    if (genUiRes) return genUiRes;

    // Host page serving an iframe just like the chat transcript does
    if (url.pathname.startsWith("/host/")) {
      const caseId = url.pathname.slice(6);
      const widgetUrl = hostedIframes[caseId];
      if (!widgetUrl) return new Response("Not found", { status: 404 });

      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Host Test Page</title>
  <style>
    body { margin: 0; padding: 20px; background: #121417; font-family: system-ui, sans-serif; color: #eee; }
    .card { background: #1b1e21; border: 1px solid #30343a; border-radius: 12px; padding: 12px; max-width: 640px; margin: 0 auto; }
    iframe { width: 100%; border: 0; display: block; border-radius: 8px; min-height: 400px; }
  </style>
</head>
<body>
  <div class="card">
    <iframe title="Interactive widget" sandbox="allow-scripts" src="${widgetUrl}"></iframe>
  </div>
  <script>
    window.addEventListener("message", (ev) => {
      if (ev.data && ev.data.__gu === "resize") {
        const frame = document.querySelector("iframe");
        if (frame && ev.data.height > 0) frame.style.height = ev.data.height + "px";
      }
    });
  </script>
</body>
</html>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[test-server] listening at ${ORIGIN}`);

// ---- CASE 1: AI Markdown with Matter.js 2D physics ----
const AI_MD_MATTER = [
  "Here is an interactive 2D physics demonstration of rigid-body gravity and restitution:",
  "",
  "```generative_ui",
  "@jsx",
  'import React, { useState, useEffect, useRef } from "react";',
  'import Matter from "matter-js";',
  "",
  "export default function App() {",
  "  const [gravity, setGravity] = useState(1);",
  "  const [restitution, setRestitution] = useState(0.85);",
  "  const [ballY, setBallY] = useState(40);",
  "  const [stepCount, setStepCount] = useState(0);",
  "  const canvasRef = useRef(null);",
  "  const engineRef = useRef(null);",
  "  const ballRef = useRef(null);",
  "  const lastTimeRef = useRef(performance.now());",
  "",
  "  useEffect(() => {",
  "    const canvas = canvasRef.current;",
  "    if (!canvas) return;",
  '    const ctx = canvas.getContext("2d");',
  "    if (!ctx) return;",
  "",
  "    const engine = Matter.Engine.create({",
  "      gravity: { x: 0, y: gravity, scale: 0.001 },",
  "    });",
  "    engineRef.current = engine;",
  "",
  "    const ground = Matter.Bodies.rectangle(180, 230, 360, 20, { isStatic: true });",
  "    const wallLeft = Matter.Bodies.rectangle(5, 120, 10, 240, { isStatic: true });",
  "    const wallRight = Matter.Bodies.rectangle(355, 120, 10, 240, { isStatic: true });",
  "",
  "    const ball = Matter.Bodies.circle(180, 40, 16, {",
  "      restitution: restitution,",
  "      friction: 0.05,",
  "    });",
  "    ballRef.current = ball;",
  "",
  "    Matter.Composite.add(engine.world, [ground, wallLeft, wallRight, ball]);",
  "",
  "    let animId = 0;",
  "    let frames = 0;",
  "    const loop = (now) => {",
  "      const dtMs = Math.min(now - lastTimeRef.current, 33);",
  "      lastTimeRef.current = now;",
  "      Matter.Engine.update(engine, dtMs);",
  "",
  "      frames++;",
  "      if (frames % 6 === 0) {",
  "        setBallY(Math.round(ball.position.y));",
  "        setStepCount((c) => c + 1);",
  "      }",
  "",
  "      ctx.clearRect(0, 0, canvas.width, canvas.height);",
  "",
  "      // Draw bounds",
  '      ctx.fillStyle = "#30343a";',
  "      [ground, wallLeft, wallRight].forEach((b) => {",
  "        ctx.beginPath();",
  "        b.vertices.forEach((v, i) => {",
  "          if (i === 0) ctx.moveTo(v.x, v.y);",
  "          else ctx.lineTo(v.x, v.y);",
  "        });",
  "        ctx.closePath();",
  "        ctx.fill();",
  "      });",
  "",
  "      // Draw ball",
  '      ctx.fillStyle = "#65b8a9";',
  "      ctx.beginPath();",
  "      ctx.arc(ball.position.x, ball.position.y, 16, 0, Math.PI * 2);",
  "      ctx.fill();",
  "",
  "      animId = requestAnimationFrame(loop);",
  "    };",
  "",
  "    animId = requestAnimationFrame(loop);",
  "",
  "    return () => {",
  "      cancelAnimationFrame(animId);",
  "      Matter.Composite.clear(engine.world, false);",
  "      Matter.Engine.clear(engine);",
  "    };",
  "  }, []);",
  "",
  "  const handleReset = () => {",
  "    if (ballRef.current) {",
  "      Matter.Body.setPosition(ballRef.current, { x: 180, y: 40 });",
  "      Matter.Body.setVelocity(ballRef.current, { x: 0, y: 0 });",
  "      setBallY(40);",
  "    }",
  "  };",
  "",
  "  return (",
  '    <div className="gu-root">',
  '      <div className="gu-header">',
  '        <h3 className="gu-title">2D Rigid-Body Physics (Matter.js)</h3>',
  '        <p className="gu-caption">Simulating falling and bouncing rigid bodies with 60fps physics step.</p>',
  "      </div>",
  '      <div className="gu-stage" style={{ width: "360px", margin: "0 auto 12px" }}>',
  '        <canvas ref={canvasRef} width={360} height={240} style={{ display: "block", background: "#24272b" }} />',
  "      </div>",
  '      <div className="gu-col">',
  '        <div className="gu-row">',
  '          <button className="gu-btn gu-btn-primary" onClick={handleReset} id="btn-reset-2d">',
  "            Reset Ball Position",
  "          </button>",
  '          <span className="gu-badge gu-badge-ok" id="badge-ball-y">Y: {ballY}px</span>',
  '          <span className="gu-badge" id="badge-steps">Steps: {stepCount}</span>',
  "        </div>",
  "      </div>",
  "    </div>",
  "  );",
  "}",
  "```",
  "",
  "Hope this illustrates Matter.js 2D physics integration!",
].join("\n");

// ---- CASE 2: AI Markdown with Three.js + Cannon-es 3D physics ----
const AI_MD_CANNON = [
  "Here is an interactive 3D physics explainer using Three.js and Cannon-es:",
  "",
  "```generative_ui",
  "@jsx",
  'import React, { useState, useEffect, useRef } from "react";',
  'import * as THREE from "three";',
  'import * as CANNON from "cannon-es";',
  "",
  "export default function App() {",
  "  const [sphereY, setSphereY] = useState(4.5);",
  "  const [bounceCount, setBounceCount] = useState(0);",
  "  const containerRef = useRef(null);",
  "  const worldRef = useRef(null);",
  "  const sphereBodyRef = useRef(null);",
  "  const sphereMeshRef = useRef(null);",
  "  const lastTimeRef = useRef(performance.now());",
  "",
  "  useEffect(() => {",
  "    const container = containerRef.current;",
  "    if (!container) return;",
  "",
  "    // Three.js Scene",
  "    const scene = new THREE.Scene();",
  "    const camera = new THREE.PerspectiveCamera(50, 360 / 240, 0.1, 100);",
  "    camera.position.set(0, 5, 9);",
  "    camera.lookAt(0, 1.5, 0);",
  "",
  "    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });",
  "    renderer.setSize(360, 240);",
  "    container.appendChild(renderer.domElement);",
  "",
  "    const light = new THREE.DirectionalLight(0xffffff, 1.5);",
  "    light.position.set(5, 10, 7);",
  "    scene.add(light);",
  "    scene.add(new THREE.AmbientLight(0xffffff, 0.5));",
  "",
  "    // Floor",
  "    const floorGeo = new THREE.PlaneGeometry(8, 8);",
  "    const floorMat = new THREE.MeshStandardMaterial({ color: 0x30343a });",
  "    const floorMesh = new THREE.Mesh(floorGeo, floorMat);",
  "    floorMesh.rotation.x = -Math.PI / 2;",
  "    scene.add(floorMesh);",
  "",
  "    // Sphere",
  "    const sphereGeo = new THREE.SphereGeometry(0.7, 32, 32);",
  "    const sphereMat = new THREE.MeshStandardMaterial({ color: 0x65b8a9, roughness: 0.2 });",
  "    const sphereMesh = new THREE.Mesh(sphereGeo, sphereMat);",
  "    scene.add(sphereMesh);",
  "    sphereMeshRef.current = sphereMesh;",
  "",
  "    // Cannon-es Physics World",
  "    const world = new CANNON.World({",
  "      gravity: new CANNON.Vec3(0, -9.82, 0),",
  "    });",
  "    worldRef.current = world;",
  "",
  '    const groundMaterial = new CANNON.Material("ground");',
  '    const sphereMaterial = new CANNON.Material("sphere");',
  "",
  "    const contactMaterial = new CANNON.ContactMaterial(groundMaterial, sphereMaterial, {",
  "      restitution: 0.7,",
  "      friction: 0.1,",
  "    });",
  "    world.addContactMaterial(contactMaterial);",
  "",
  "    const groundBody = new CANNON.Body({",
  "      type: CANNON.Body.STATIC,",
  "      shape: new CANNON.Plane(),",
  "      material: groundMaterial,",
  "    });",
  "    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);",
  "    world.addBody(groundBody);",
  "",
  "    const sphereBody = new CANNON.Body({",
  "      mass: 1,",
  "      shape: new CANNON.Sphere(0.7),",
  "      position: new CANNON.Vec3(0, 4.5, 0),",
  "      material: sphereMaterial,",
  "    });",
  "    world.addBody(sphereBody);",
  "    sphereBodyRef.current = sphereBody;",
  "",
  '    sphereBody.addEventListener("collide", () => {',
  "      setBounceCount((c) => c + 1);",
  "    });",
  "",
  "    let animId = 0;",
  "    let frames = 0;",
  "    const loop = (now) => {",
  "      const dtSec = Math.min((now - lastTimeRef.current) / 1000, 0.1);",
  "      lastTimeRef.current = now;",
  "",
  "      world.step(1 / 60, dtSec, 3);",
  "",
  "      sphereMesh.position.copy(sphereBody.position as any);",
  "      sphereMesh.quaternion.copy(sphereBody.quaternion as any);",
  "",
  "      frames++;",
  "      if (frames % 6 === 0) {",
  "        setSphereY(parseFloat(sphereBody.position.y.toFixed(2)));",
  "      }",
  "",
  "      renderer.render(scene, camera);",
  "      animId = requestAnimationFrame(loop);",
  "    };",
  "",
  "    animId = requestAnimationFrame(loop);",
  "",
  "    return () => {",
  "      cancelAnimationFrame(animId);",
  "      renderer.dispose();",
  "      floorGeo.dispose();",
  "      sphereGeo.dispose();",
  "      floorMat.dispose();",
  "      sphereMat.dispose();",
  "      if (container.contains(renderer.domElement)) {",
  "        container.removeChild(renderer.domElement);",
  "      }",
  "    };",
  "  }, []);",
  "",
  "  const handleDrop = () => {",
  "    if (sphereBodyRef.current) {",
  "      sphereBodyRef.current.position.set(0, 5, 0);",
  "      sphereBodyRef.current.velocity.set(0, 0, 0);",
  "      setSphereY(5.0);",
  "    }",
  "  };",
  "",
  "  return (",
  '    <div className="gu-root">',
  '      <div className="gu-header">',
  '        <h3 className="gu-title">3D Rigid-Body Physics (Three.js + Cannon-es)</h3>',
  '        <p className="gu-caption">Synchronized Three.js mesh and Cannon-es collision body.</p>',
  "      </div>",
  '      <div className="gu-stage" ref={containerRef} style={{ width: "360px", height: "240px", margin: "0 auto 12px" }} />',
  '      <div className="gu-col">',
  '        <div className="gu-row">',
  '          <button className="gu-btn gu-btn-primary" onClick={handleDrop} id="btn-drop-3d">',
  "            Drop Sphere Again",
  "          </button>",
  '          <span className="gu-badge gu-badge-ok" id="badge-sphere-y">Sphere Y: {sphereY}</span>',
  '          <span className="gu-badge" id="badge-bounce">Collisions: {bounceCount}</span>',
  "        </div>",
  "      </div>",
  "    </div>",
  "  );",
  "}",
  "```",
  "",
  "All 3D simulations are fully hardware-accelerated.",
].join("\n");

async function publishWidget(markdownText: string): Promise<string> {
  const segs = splitGenerativeUiSegments(markdownText);
  const widgetSeg = segs.find((s) => s.kind === "widget") as any;
  assert(widgetSeg && widgetSeg.body, "Failed to find generative_ui widget segment in markdown");

  const parsed = parseGenerativeUiDsl(widgetSeg.body);
  assert(parsed.jsx, "Failed to parse @jsx from markdown block");

  const res = await fetch(`${ORIGIN}/api/indirect-code/gen-ui/widgets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      theme: "dark",
      jsx: parsed.jsx,
      stateJSON: JSON.stringify(parsed.state ?? {}),
    }),
  });

  const body: any = await res.json();
  assert(res.ok && body.success && body.url, `Publish failed (status ${res.status}): ${JSON.stringify(body)}`);
  return body.url;
}

async function runBrowserTests() {
  console.log("[test] Publishing Matter.js widget from AI markdown...");
  const matterUrl = await publishWidget(AI_MD_MATTER);
  hostedIframes["matter"] = matterUrl;
  console.log(`[test] Matter.js published at ${matterUrl}`);

  console.log("[test] Publishing Cannon-es widget from AI markdown...");
  const cannonUrl = await publishWidget(AI_MD_CANNON);
  hostedIframes["cannon"] = cannonUrl;
  console.log(`[test] Cannon-es published at ${cannonUrl}`);

  console.log("[test] Launching real Chromium browser...");
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on("pageerror", (e: any) => pageErrors.push(String(e)));
    page.on("console", (msg: any) => {
      if (msg.type() === "error" && !/favicon|status of 404/i.test(msg.text())) {
        consoleErrors.push(msg.text());
      }
    });

    // ==========================================
    // TEST 1: Matter.js in real browser
    // ==========================================
    console.log("\n--- Testing 2D Physics (Matter.js) in real browser ---");
    await page.goto(`${ORIGIN}/host/matter`, { waitUntil: "networkidle" });

    const matterFrameEl = await page.waitForSelector('iframe[title="Interactive widget"]', { timeout: 10000 });
    assert(matterFrameEl, "Matter iframe element not found");

    const matterFrame = await matterFrameEl.contentFrame();
    assert(matterFrame, "Matter iframe contentFrame not accessible");

    // Wait for widget root and canvas
    await matterFrame.waitForSelector(".gu-root", { timeout: 10000 });
    await matterFrame.waitForSelector("canvas", { timeout: 10000 });
    console.log("[test] Matter.js canvas and UI root mounted successfully");

    // Check globals
    const hasGlobals2D = await matterFrame.evaluate(() => {
      return {
        hasMatterGlobal: typeof (window as any).Matter === "object",
        hasEngineCreate: typeof (window as any).Matter?.Engine?.create === "function",
        hasBodies: typeof (window as any).Matter?.Bodies?.circle === "function",
      };
    });
    console.log("[test] Matter.js API verification:", hasGlobals2D);
    assert(hasGlobals2D.hasMatterGlobal, "window.Matter global is missing in iframe");
    assert(hasGlobals2D.hasEngineCreate, "Matter.Engine.create is missing");
    assert(hasGlobals2D.hasBodies, "Matter.Bodies.circle is missing");

    // 1. Initial fall check: ball started at 40px and fell to ground (~194px)
    const badgeText0 = await matterFrame.textContent("#badge-ball-y");
    const y0 = parseFloat(badgeText0.replace(/[^0-9.]/g, ""));
    console.log(`[test] Ball position after initial falling on mount: ${badgeText0} (${y0}px)`);
    assert(y0 > 150, `Ball did not fall to the floor on mount (expected >150, got ${y0})`);

    // 2. Test interactivity: click Reset button inside iframe
    console.log("[test] Clicking Reset Ball button...");
    await matterFrame.click("#btn-reset-2d");
    await page.waitForTimeout(50);
    const badgeTextReset = await matterFrame.textContent("#badge-ball-y");
    const yReset = parseFloat(badgeTextReset.replace(/[^0-9.]/g, ""));
    console.log(`[test] Ball position badge immediately after Reset: ${badgeTextReset} (${yReset}px)`);
    assert(yReset < 80, `Ball was not reset to top (expected <80, got ${yReset})`);

    // 3. Verify ball falls again under gravity after reset
    await page.waitForTimeout(600);
    const badgeTextAfter = await matterFrame.textContent("#badge-ball-y");
    const yAfter = parseFloat(badgeTextAfter.replace(/[^0-9.]/g, ""));
    console.log(`[test] Ball position badge after falling again: ${badgeTextAfter} (${yAfter}px)`);
    assert(yAfter > yReset + 30, `Ball did not resume falling after reset (yReset=${yReset}, yAfter=${yAfter})`);

    // Take screenshot of 2D physics widget
    const shotPath2D = path.join(SHOTS_DIR, "physics-2d-matter-real-browser.png");
    await page.screenshot({ path: shotPath2D });
    console.log(`[test] Screenshot saved: ${shotPath2D}`);

    // ==========================================
    // TEST 2: Three.js + Cannon-es in real browser
    // ==========================================
    console.log("\n--- Testing 3D Physics (Three.js + Cannon-es) in real browser ---");
    await page.goto(`${ORIGIN}/host/cannon`, { waitUntil: "networkidle" });

    const cannonFrameEl = await page.waitForSelector('iframe[title="Interactive widget"]', { timeout: 10000 });
    const cannonFrame = await cannonFrameEl.contentFrame();
    assert(cannonFrame, "Cannon iframe contentFrame not accessible");

    await cannonFrame.waitForSelector(".gu-root", { timeout: 10000 });
    await cannonFrame.waitForSelector("canvas", { timeout: 10000 });
    console.log("[test] Three.js + Cannon-es canvas and UI mounted successfully");

    // Check globals & physics initialization
    const hasGlobals3D = await cannonFrame.evaluate(() => {
      return {
        hasThreeGlobal: typeof (window as any).THREE === "object",
        hasCannonGlobal: typeof (window as any).CANNON === "object",
        hasWorldClass: typeof (window as any).CANNON?.World === "function",
        hasBodyClass: typeof (window as any).CANNON?.Body === "function",
      };
    });
    console.log("[test] 3D Globals API verification:", hasGlobals3D);
    assert(hasGlobals3D.hasThreeGlobal, "window.THREE global missing in iframe");
    assert(hasGlobals3D.hasCannonGlobal, "window.CANNON global missing in iframe");
    assert(hasGlobals3D.hasWorldClass, "CANNON.World is missing");
    assert(hasGlobals3D.hasBodyClass, "CANNON.Body is missing");

    // 1. Initial fall check: sphere started at Y=4.5 and is dropping under gravity
    const sphereText0 = await cannonFrame.textContent("#badge-sphere-y");
    const sphereY0 = parseFloat(sphereText0.replace(/[^0-9.-]/g, ""));
    console.log(`[test] 3D Sphere initial position: ${sphereText0} (${sphereY0})`);
    assert(sphereY0 < 4.5, `Sphere did not fall under gravity on mount (expected <4.5, got ${sphereY0})`);

    // Wait for sphere to continue falling towards floor
    await page.waitForTimeout(500);
    const sphereTextGround = await cannonFrame.textContent("#badge-sphere-y");
    const sphereYGround = parseFloat(sphereTextGround.replace(/[^0-9.-]/g, ""));
    console.log(`[test] 3D Sphere position after 500ms: ${sphereTextGround} (${sphereYGround})`);
    assert(sphereYGround < sphereY0, `Sphere did not continue falling (expected <${sphereY0}, got ${sphereYGround})`);

    // 2. Test button interaction: Drop Sphere Again
    console.log("[test] Clicking Drop Sphere Again button...");
    await cannonFrame.click("#btn-drop-3d");
    await page.waitForTimeout(50);
    const sphereTextReset = await cannonFrame.textContent("#badge-sphere-y");
    const sphereYReset = parseFloat(sphereTextReset.replace(/[^0-9.-]/g, ""));
    console.log(`[test] 3D Sphere Y badge immediately after Drop button: ${sphereTextReset} (${sphereYReset})`);
    assert(sphereYReset > 4.0, `Sphere was not reset to height > 4.0 (got ${sphereYReset})`);

    // 3. Verify sphere falls again after drop
    await page.waitForTimeout(500);
    const sphereTextAfter = await cannonFrame.textContent("#badge-sphere-y");
    const sphereYAfter = parseFloat(sphereTextAfter.replace(/[^0-9.-]/g, ""));
    console.log(`[test] 3D Sphere Y badge after falling again: ${sphereTextAfter} (${sphereYAfter})`);
    assert(sphereYAfter < sphereYReset, `Sphere did not fall after drop (sphereYReset=${sphereYReset}, sphereYAfter=${sphereYAfter})`);

    // Take screenshot of 3D physics widget
    const shotPath3D = path.join(SHOTS_DIR, "physics-3d-cannon-real-browser.png");
    await page.screenshot({ path: shotPath3D });
    console.log(`[test] Screenshot saved: ${shotPath3D}`);

    // Verify error arrays
    assert.deepEqual(pageErrors, [], `Encountered page errors: ${pageErrors.join(" | ")}`);
    assert.deepEqual(consoleErrors, [], `Encountered console errors: ${consoleErrors.join(" | ")}`);

    console.log("\n=======================================================");
    console.log("✅ ALL REAL BROWSER PHYSICS TESTS PASSED PERFECTLY!");
    console.log("=======================================================\n");
  } finally {
    await browser.close();
    server.stop();
  }
}

try {
  await runBrowserTests();
  process.exit(0);
} catch (err) {
  console.error("Test failed:", err);
  if (server) server.stop();
  process.exit(1);
}
