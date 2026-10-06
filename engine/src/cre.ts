// Runs the royale-settle workflow in the CRE CLI simulator for one lobby (scripts/cre-settler.mts, SETTLE_MODE=cre).
// The workflow (workflow/src/main.ts) reads the lobby, fetches the final book from the engine and the candles, scores
// them, and with --broadcast the simulator writes the report through Chainlink's MockKeystoneForwarder, which calls
// the escrow's onReport. Real workflow code and the real forwarder path, but one simulator process, not DON
// consensus. The CLI needs a logged-in user (`cre login`), so this runs on an operator's machine, not in the hosted
// engine. Runs are serialized: one simulator at a time.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { redact } from "./chain.ts";

export const WORKFLOW_DIR = resolve(import.meta.dirname, "../../workflow");
const CHAIN_NAMES: Record<string, string> = { "base-sepolia": "ethereum-testnet-sepolia-base-1" };
const TX_RE = /settled lobby (\d+), txHash (0x[0-9a-fA-F]{64})/;
// Keys in this list never reach the simulator: the deployer and relayer nonces belong to the engine's queue.
const WITHHELD = ["PRIVATE_KEY_DEPLOYER", "PRIVATE_KEY_RELAYER", "PRIVATE_KEY_CRE", "CRE_ETH_PRIVATE_KEY"];

export type CreRun = {
  ok: boolean;
  txHash: `0x${string}` | null;
  result: { lobbyId?: string; bookHash?: string; winners?: string[]; amounts?: string[]; report?: string; txHash?: string } | null;
  error: string | null; // the simulator's "workflow execution failed" line, a timeout, or the exit code
  userLogs: string[];
};

export type CreConfig = { cli: string; wasm: string | null; key: string; timeoutMs: number };

/** The CLI binary: CRE_CLI, else `cre` on PATH, else ~/.cre/bin/cre (where the official installer puts it). */
function findCli(env: NodeJS.ProcessEnv): string | null {
  const candidates = [env.CRE_CLI, "cre", resolve(homedir(), ".cre/bin/cre")].filter(Boolean) as string[];
  for (const c of candidates) {
    const r = spawnSync(c, ["version"], { encoding: "utf8", timeout: 20_000 });
    if (r.status === 0 && /CRE CLI version/i.test(r.stdout + r.stderr)) return c;
  }
  return null;
}

const strip0x = (k: string) => k.trim().replace(/^0x/i, "").toLowerCase();

/**
 * Start-up checks for the CRE settler. Throws (it refuses to start) when PRIVATE_KEY_CRE is missing, malformed, or
 * equals the deployer or relayer key, when CHAIN has no CRE chain name here, or when the CLI cannot be found.
 */
export function creConfig(env: NodeJS.ProcessEnv, log: (m: string) => void): CreConfig {
  const key = (env.PRIVATE_KEY_CRE ?? "").trim();
  if (!key) throw new Error("the CRE settler needs PRIVATE_KEY_CRE (a dedicated funded key, not the deployer or relayer)");
  if (!/^[0-9a-f]{64}$/.test(strip0x(key))) throw new Error("PRIVATE_KEY_CRE is not a 32-byte hex private key");
  for (const other of ["PRIVATE_KEY_DEPLOYER", "PRIVATE_KEY_RELAYER"]) {
    if (env[other] && strip0x(env[other]!) === strip0x(key)) throw new Error(`PRIVATE_KEY_CRE must not equal ${other} (the engine's tx queue owns that nonce)`);
  }
  const chain = (env.CHAIN ?? "").trim();
  if (!CHAIN_NAMES[chain]) throw new Error(`the CRE settler supports CHAIN=${Object.keys(CHAIN_NAMES).join(", ")} (workflow/project.yaml), got ${chain}`);
  const cli = findCli(env);
  if (!cli) throw new Error("CRE CLI not found (set CRE_CLI, put cre on PATH, or install to ~/.cre/bin)");
  const wasm = (env.CRE_WASM ?? "").trim() || null;
  if (wasm && !existsSync(wasm)) throw new Error(`CRE_WASM ${wasm} does not exist`);
  const timeoutMs = Number(env.CRE_RUN_TIMEOUT_MS ?? 180_000);
  log(`[cre] auth: ${env.CRE_API_KEY ? "CRE_API_KEY" : "the CLI's saved login (cre login)"}`);
  log(`[cre] CLI ${cli.replace(homedir(), "~")}, ${wasm ? `prebuilt WASM ${wasm}` : "WASM compiled on the first run"}, run timeout ${timeoutMs / 1000}s`);
  return { cli, wasm, key: strip0x(key), timeoutMs };
}

/** The simulator's env: the parent's, minus every engine key, plus CRE_ETH_PRIVATE_KEY = PRIVATE_KEY_CRE. */
function childEnv(cfg: CreConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of WITHHELD) delete env[k];
  env.CRE_ETH_PRIVATE_KEY = cfg.key;
  return env;
}

/** Strips ANSI colour codes the CLI prints. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

/** Pulls the txHash, the handler's returned JSON and the failure line out of the simulator's output. */
export function parseCreOutput(out: string, lobbyId: number): Omit<CreRun, "ok"> {
  const text = plain(out);
  const userLogs = [...text.matchAll(/\[USER LOG\]\s*(.*)/g)].map((m) => m[1].trim());
  let txHash: `0x${string}` | null = null;
  for (const l of userLogs) {
    const m = TX_RE.exec(l);
    if (m && Number(m[1]) === lobbyId) txHash = m[2].toLowerCase() as `0x${string}`;
  }
  // "Workflow Simulation Result:" then, on the next line, the handler's return value: a JSON-encoded JSON string.
  let result: CreRun["result"] = null;
  const m = /Workflow Simulation Result:?\s*\n\s*(.+)/i.exec(text);
  if (m) {
    try {
      let v: unknown = JSON.parse(m[1].trim());
      if (typeof v === "string") v = JSON.parse(v);
      if (v && typeof v === "object") result = v as CreRun["result"];
    } catch { /* not JSON: leave null; the txHash comes from the user log */ }
  }
  if (!txHash && result?.txHash && /^0x[0-9a-fA-F]{64}$/.test(result.txHash)) txHash = result.txHash.toLowerCase() as `0x${string}`;
  const fail = /(?:✗|Error:)\s*(.*(?:failed|error).*)/i.exec(text);
  return { txHash, result, error: fail ? fail[1].trim().slice(0, 400) : null, userLogs };
}

let queue: Promise<unknown> = Promise.resolve();
let wasmBuild: Promise<string | null> | null = null;

/** Compiles the workflow once (cre workflow build) and reuses the WASM for every run; null if the build fails. */
export function prebuilt(cfg: CreConfig, log: (m: string) => void): Promise<string | null> {
  if (cfg.wasm) return Promise.resolve(cfg.wasm);
  wasmBuild ??= new Promise((res) => {
    const out = resolve(WORKFLOW_DIR, "royale-settle.wasm");
    const p = spawn(cfg.cli, ["workflow", "build", ".", "-o", out, "--non-interactive"], { cwd: WORKFLOW_DIR, env: childEnv(cfg), stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    p.stdout.on("data", (b) => (text += b)); p.stderr.on("data", (b) => (text += b));
    const timer = setTimeout(() => p.kill("SIGKILL"), 300_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(out)) { log(`[cre] workflow compiled to ${out}`); res(out); return; }
      log(`[cre] workflow build failed (exit ${code}); each run compiles instead: ${redact(plain(text)).split("\n").filter(Boolean).slice(-3).join(" | ")}`);
      wasmBuild = null;
      res(null);
    });
  });
  return wasmBuild;
}

/**
 * Runs `cre workflow simulate` for one lobby (with --broadcast unless `broadcast` is false). `engineUrl` is where the
 * workflow fetches the final book. Serialized with every other run; killed after cfg.timeoutMs. Every output line is logged redacted.
 */
export function runCreSettle(cfg: CreConfig, lobbyId: number, engineUrl: string, escrow: string, log: (m: string) => void, broadcast = true): Promise<CreRun> {
  const run = async (): Promise<CreRun> => {
    // Short relative path: the CLI refuses a --config path over 97 characters.
    const base = JSON.parse(readFileSync(resolve(WORKFLOW_DIR, "config.staging.json"), "utf8"));
    const cfgName = `config.run-${process.pid}.json`;
    writeFileSync(resolve(WORKFLOW_DIR, cfgName), JSON.stringify({ ...base, engineUrl, escrowAddress: escrow }, null, 2));
    const wasm = await prebuilt(cfg, log);
    const args = ["workflow", "simulate", ".", "--target", "staging-settings", "--config", `./${cfgName}`,
      "--http-payload", JSON.stringify({ lobbyId }), "--trigger-index", "0", "--non-interactive", ...(broadcast ? ["--broadcast"] : []),
      "--evm-receipt-timeout", "2m", ...(wasm ? ["--wasm", wasm] : [])];
    log(`[cre] lobby ${lobbyId}: cre workflow simulate${broadcast ? " --broadcast" : " (dry run)"}${wasm ? " --wasm" : ""}`);
    const p = spawn(cfg.cli, args, { cwd: WORKFLOW_DIR, env: childEnv(cfg), stdio: ["ignore", "pipe", "pipe"], detached: true });
    let text = "";
    let buf = "";
    const onData = (b: Buffer) => {
      const s = b.toString();
      text += s;
      if (text.length > 2_000_000) text = text.slice(-1_000_000);
      buf += s;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = plain(buf.slice(0, i)).trim();
        buf = buf.slice(i + 1);
        if (line) log(`[cre] ${line.length > 300 ? line.slice(0, 300) + "..." : line}`);
      }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } }, cfg.timeoutMs);
    const code = await new Promise<number | null>((res) => { p.on("close", (c) => res(c)); p.on("error", () => res(-1)); });
    clearTimeout(timer);
    const parsed = parseCreOutput(text, lobbyId);
    const error = timedOut ? `simulator timed out after ${cfg.timeoutMs / 1000}s` : parsed.error ?? (code === 0 ? null : `simulator exited ${code}`);
    try { unlinkSync(resolve(WORKFLOW_DIR, cfgName)); } catch { /* already gone */ }
    return { ok: !timedOut && code === 0 && !!parsed.txHash, ...parsed, error: error && redact(error) };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}
