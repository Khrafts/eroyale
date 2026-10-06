// Screenshots of every screen against the mock. Starts `next start` itself.
// Env: SHOTS_DIR (output dir, default ./shots), SHOTS_ONLY (comma list), ARENA_V (a|b|c), PORT.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const OUT = process.env.SHOTS_DIR || "shots";
const PORT = Number(process.env.PORT || 3123);
const V = process.env.ARENA_V ? `&v=${process.env.ARENA_V}` : "";
const BASE = `http://127.0.0.1:${PORT}`;
const ARENA = { width: 1920, height: 1080 };
const PHONE = { width: 390, height: 844 };

const SHOTS = [
  { name: "arena-lobby", path: `/arena?mock=1&speed=0&at=lobby${V}`, size: ARENA },
  { name: "arena-live", path: `/arena?mock=1&speed=0&at=live${V}`, size: ARENA },
  { name: "arena-checkpoint", path: `/arena?mock=1&speed=0&at=checkpoint${V}`, size: ARENA },
  { name: "arena-final", path: `/arena?mock=1&speed=0&at=settled${V}`, size: ARENA },
  { name: "trade", path: `/play?mock=1&speed=0&at=live`, size: PHONE },
  { name: "trade-danger", path: `/play?mock=1&speed=0&at=danger`, size: PHONE },
  { name: "eliminated", path: `/play?mock=1&speed=0&at=eliminated`, size: PHONE },
  { name: "result", path: `/play?mock=1&speed=0&at=result&me=winner`, size: PHONE },
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

async function launch() {
  try {
    return await chromium.launch();
  } catch (e) {
    console.error("bundled chromium unavailable, trying installed Chrome:", String(e).split("\n")[0]);
    return await chromium.launch({ channel: "chrome" });
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
    await page.goto(BASE + s.path, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(Number(process.env.SHOTS_WAIT || 2500));
    const file = join(OUT, `${s.name}.png`);
    await page.screenshot({ path: file });
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
