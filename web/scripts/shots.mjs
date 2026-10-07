// Screenshots of every screen against the mock (royale ?mock=1, prediction ?mock=predict, island ?mock=island, duel ?mock=duel). Starts `next start` itself.
// Env: SHOTS_DIR (output dir, default ./shots), SHOTS_ONLY (comma list), PORT.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const OUT = process.env.SHOTS_DIR || "shots";
const PORT = Number(process.env.PORT || 3123);
const BASE = `http://127.0.0.1:${PORT}`;
const ARENA = { width: 1920, height: 1080 };
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };

const SHOTS = [
  { name: "arena-lobby", path: `/arena?mock=1&speed=0&at=lobby`, size: ARENA },
  { name: "arena-live", path: `/arena?mock=1&speed=0&at=live`, size: ARENA },
  { name: "arena-checkpoint", path: `/arena?mock=1&speed=0&at=checkpoint`, size: ARENA },
  { name: "arena-final", path: `/arena?mock=1&speed=0&at=settled`, size: ARENA },
  { name: "trade", path: `/play?mock=1&speed=0&at=live`, size: PHONE },
  { name: "trade-danger", path: `/play?mock=1&speed=0&at=danger`, size: PHONE },
  { name: "eliminated", path: `/play?mock=1&speed=0&at=eliminated`, size: PHONE },
  { name: "result", path: `/play?mock=1&speed=0&at=result&me=winner`, size: PHONE },
  // Prediction mode (?mock=predict): the protocol round, KESTREL (me) finishes 3rd of 5 winners.
  { name: "arena-predict-live", path: `/arena?mock=predict&speed=0&at=close`, size: ARENA },
  { name: "arena-predict-reveal", path: `/arena?mock=predict&speed=0&at=final`, size: ARENA },
  { name: "rounds", path: `/play?mock=predict&speed=0&at=open&screen=rounds`, size: PHONE },
  { name: "create-round", path: `/play?mock=predict&speed=0&at=open&screen=create`, size: PHONE },
  { name: "predict", path: `/play?mock=predict&speed=0&at=open`, size: PHONE },
  { name: "predict-result", path: `/play?mock=predict&speed=0&at=settled`, size: PHONE },
  // The island (?mock=island): WebGL in headless Chrome through SwiftShader; each shot waits for window.__islandReady.
  { name: "island-overview", path: `/?mock=island&at=overview`, size: DESK, island: true },
  { name: "island-panel", path: `/?mock=island&at=live`, size: DESK, island: true, click: "The Arena" },
  { name: "island-studio", path: `/?mock=island&at=studio`, size: DESK, island: true },
  { name: "island-victory", path: `/?mock=island&at=victory`, size: DESK, island: true },
  { name: "island-list", path: `/?view=list&mock=island`, size: DESK },
  { name: "island-phone", path: `/?mock=island&at=overview`, size: PHONE, island: true },
  // Stickman Duel (?mock=duel): a frozen bot-against-bot match through the rules; the island with the Dojo panel open.
  { name: "duel-practice", path: `/duel?mock=duel&at=practice`, size: PHONE },
  { name: "duel-fight", path: `/duel?mock=duel&at=fight`, size: PHONE },
  { name: "duel-result", path: `/duel?mock=duel&at=result`, size: PHONE },
  { name: "arena-duel", path: `/arena?mock=duel&at=fight`, size: ARENA },
  { name: "island-dojo", path: `/?mock=island&at=dojo`, size: DESK, island: true },
];

const only = process.env.SHOTS_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
const todo = only?.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;

async function waitUp(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not start at ${url}`);
}

// SwiftShader gives headless Chrome a software WebGL for the island; the 2D screens do not use it.
const GL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
async function launch() {
  try {
    return await chromium.launch({ args: GL_ARGS });
  } catch (e) {
    console.error("bundled chromium unavailable, trying installed Chrome:", String(e).split("\n")[0]);
    return await chromium.launch({ channel: "chrome", args: GL_ARGS });
  }
}

mkdirSync(OUT, { recursive: true });
const server = spawn("npx", ["next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, NEXT_PUBLIC_ENGINE_WS: "" },
  detached: true,
});
let code = 0;
try {
  await waitUp(`${BASE}/arena`);
  const browser = await launch();
  for (const s of todo) {
    const ctx = await browser.newContext({ viewport: s.size, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[${s.name}] page error:`, e.message));
    await page.goto(BASE + s.path, { waitUntil: s.island ? "load" : "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    if (s.island) {
      // the scene is up with every building popped in; then let flights, panels and confetti settle (software GL is slow)
      await page.waitForFunction(() => window.__islandReady === true, null, { timeout: 120000, polling: 250 });
      if (s.click) {
        await page.waitForTimeout(1500);
        await page.evaluate((label) => [...document.querySelectorAll(".tag")].find((e) => e.textContent.includes(label))?.click(), s.click);
      }
      await page.waitForTimeout(Number(process.env.SHOTS_ISLAND_WAIT || 6000));
    } else await page.waitForTimeout(Number(process.env.SHOTS_WAIT || 2500));
    const file = join(OUT, `${s.name}.png`);
    await page.screenshot({ path: file, timeout: 120000 });
    console.log("wrote", file);
    await ctx.close();
  }
  await browser.close();
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  try { process.kill(-server.pid, "SIGTERM"); } catch {}
}
process.exit(code);
