// Regression check for the protocol-round catch-up loop (lobbies 155-327 on Base Sepolia, 2026-10-06).
//   npx tsx scripts/check-round-loop.mts            # both parts, about 3 minutes
//   npx tsx scripts/check-round-loop.mts --unit     # part 1 only
//
// Part 1, nonce classification: a send that fails in transport must not count as a used nonce. viem prints the request
// arguments ("nonce: 837") in every write error's message, and the old /nonce/ test on that message bumped the
// relayer's local nonce past a nonce the chain never saw: every later relayer tx sat behind the gap until its receipt
// timed out. Checked against a stub JSON-RPC server, nothing sent anywhere else.
//
// Part 2, stall: a CHAIN=off engine (--predict-only --predict-bots 5, temp data dir) is frozen with SIGSTOP from the
// moment protocol round 1 opens until 75 s after its lock, then resumed. The engine must open exactly one new protocol
// round, with its full join window, cancel nothing for lack of players, and answer GET /health at once.
//
// Part 3 (--anvil, needs CHAIN=anvil, RPC_URL, keys, TOKEN_ADDRESS, ESCROW_ADDRESS, CHAIN_SELECTOR of a local anvil in
// the env, e.g. the exports of scripts/e2e-local.sh): the incident's shape on a real chain. Anvil stops mining from
// 25 s before round 1's lock until 75 s after it, so the precreated lobby, start() and every receipt stall on the
// serial queue (RECEIPT_TIMEOUT_MS=10000). After mining resumes the engine must open one round with its full window,
// with at most two createLobby calls, and keep answering HTTP throughout.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWalletClient, http, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { nonceProblem } from "../src/chain.ts";

const fails: string[] = [];
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) fails.push(what); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- part 1
async function unit() {
  let answer: unknown = null; // the JSON-RPC error eth_sendRawTransaction returns; null = drop the connection
  const stub = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const { id, method } = JSON.parse(body);
    if (method === "eth_chainId") return res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x14a34" }));
    if (answer === null) return req.socket.destroy();
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: answer }));
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const port = (stub.address() as { port: number }).port;
  const w = createWalletClient({ chain: baseSepolia, transport: http(`http://127.0.0.1:${port}`, { retryCount: 0 }), account: privateKeyToAccount(generatePrivateKey()) });
  const send = () => w.writeContract({
    address: "0x0000000000000000000000000000000000000001", abi: parseAbi(["function f()"]), functionName: "f",
    nonce: 837, gas: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n,
  }).then(() => { throw new Error("stub accepted a send"); }, (e: unknown) => e);
  const cases: [unknown, ReturnType<typeof nonceProblem>, string][] = [
    [null, null, "connection dropped (HTTP request failed)"],
    [{ code: -32000, message: "nonce too low: next nonce 838, tx nonce 837" }, "used", "nonce too low"],
    [{ code: -32000, message: "already known" }, "used", "already known"],
    [{ code: -32000, message: "replacement transaction underpriced" }, "used", "replacement underpriced"],
    [{ code: -32000, message: "nonce too high" }, "ahead", "nonce too high"],
    [{ code: -32000, message: "insufficient funds for gas * price + value" }, null, "insufficient funds"],
  ];
  for (const [err, want, what] of cases) {
    answer = err;
    const e = await send();
    const msg = e instanceof Error ? e.message : String(e);
    ok(nonceProblem(e) === want, `${what}: nonceProblem = ${nonceProblem(e)} (want ${want})${/nonce/i.test(msg) && want === null ? "; its message mentions nonce, as before" : ""}`);
  }
  stub.close();
}

// ---------- part 2
async function stall(anvil: boolean) {
  const data = mkdtempSync(join(tmpdir(), "round-loop-"));
  const rpc = async (method: string, params: unknown[]) => {
    const r = await fetch(process.env.RPC_URL!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json() as { error?: unknown };
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  };
  if (anvil && (process.env.CHAIN !== "anvil" || !/^http:\/\/(127\.0\.0\.1|localhost):/.test(process.env.RPC_URL ?? ""))) throw new Error("--anvil needs CHAIN=anvil and a local RPC_URL");
  const port = 8830 + Math.floor(Math.random() * 100);
  const entry = process.env.ROUND_LOOP_SERVER ?? "src/server.ts";
  // One process (node --import tsx), so SIGSTOP freezes the engine itself, not a launcher.
  const eng = spawn(process.execPath, ["--import", "tsx", entry, "--predict-only", "--predict-bots", "5", "--port", String(port)], {
    cwd: resolve(import.meta.dirname, ".."), env: anvil
      ? { ...process.env, ENGINE_DATA_DIR: data, RECEIPT_TIMEOUT_MS: "10000", SETTLE_MODE: "simulated", ENGINE_READ_LAG_MS: "0" }
      : { ...process.env, CHAIN: "off", ENGINE_DATA_DIR: data }, stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: { at: number; text: string }[] = [];
  let buf = "";
  const take = (d: Buffer) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push({ at: Date.now(), text: buf.slice(0, i) }); buf = buf.slice(i + 1); } };
  eng.stdout.on("data", take); eng.stderr.on("data", take);
  const opened = (from = 0) => lines.slice(from).flatMap((l) => {
    const m = /\[round (\d+)\] open, 0 players, lock (\d+)/.exec(l.text);
    return m ? [{ id: Number(m[1]), lock: Number(m[2]), at: l.at, text: l.text }] : [];
  });
  try {
    const deadline = Date.now() + 60_000;
    while (!opened().length) { if (Date.now() > deadline) throw new Error(`round 1 never opened:\n${lines.map((l) => l.text).join("\n")}`); await sleep(200); }
    const r1 = opened()[0];
    while (!lines.some((l) => /\[round \d+\] open, 5 players/.test(l.text)) && Date.now() < deadline) await sleep(200);
    const resumeAt = (r1.lock + 75) * 1000;
    let slowest = 0;
    if (anvil) {
      await sleep(r1.lock * 1000 - 25_000 - Date.now());
      console.log(`round ${r1.id} lock ${r1.lock}: anvil stops mining for ${Math.round((resumeAt - Date.now()) / 1000)} s (until 75 s after the lock)`);
      await rpc("evm_setAutomine", [false]); await rpc("evm_setIntervalMining", [0]);
      while (Date.now() < resumeAt) { // HTTP must answer while the tx queue is stalled
        const t = Date.now();
        await fetch(`http://127.0.0.1:${port}/rounds`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        slowest = Math.max(slowest, Date.now() - t);
        await sleep(2000);
      }
    } else {
      console.log(`round ${r1.id} open, lock ${r1.lock}; SIGSTOP for ${Math.round((resumeAt - Date.now()) / 1000)} s (until 75 s after its lock)`);
      eng.kill("SIGSTOP");
      await sleep(resumeAt - Date.now());
    }
    const mark = lines.length;
    if (anvil) await rpc("evm_setIntervalMining", [1]); else eng.kill("SIGCONT");
    const resumed = Date.now();
    const t0 = Date.now();
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
    const healthMs = Date.now() - t0;
    await sleep(anvil ? 40_000 : 8000);
    if (anvil) {
      ok(slowest < 2000, `GET /rounds answered within ${slowest} ms throughout the stall`);
      const creates = lines.slice(mark).filter((l) => /\[chain\] createLobby\(/.test(l.text)).length;
      ok(creates <= 2, `${creates} createLobby after mining resumed (at most 2: the stalled one and the next round's early one)`);
      console.log(lines.filter((l) => /\[chain\] (createLobby|start|cancel)|no receipt|round \d+\] (open, 0|cancelled|the previous)/.test(l.text)).map((l) => l.text).join("\n"));
    }
    const after = opened(mark);
    const tail = lines.slice(mark).map((l) => l.text);
    console.log(tail.filter((l) => /\[round /.test(l)).slice(0, 30).join("\n"));
    ok(health && healthMs < 2000, `GET /health answered ${healthMs} ms after the resume`);
    ok(after.length === 1, `exactly one protocol round opened after the stall (got ${after.length}: ${after.map((x) => x.id).join(", ")})`);
    for (const x of after) ok(x.lock - Math.floor(resumed / 1000) >= 58, `round ${x.id} opened with ${x.lock - Math.floor(resumed / 1000)} s to its lock (protocol lockAfter 60)`);
    const cancelled = tail.filter((l) => /cancelled: 0 players at the lock/.test(l));
    ok(cancelled.length === 0, `no round cancelled with 0 players after the stall (got ${cancelled.length})`);
  } finally {
    eng.kill("SIGCONT"); eng.kill("SIGTERM");
    rmSync(data, { recursive: true, force: true });
  }
}

await unit();
if (!process.argv.includes("--unit")) await stall(process.argv.includes("--anvil"));
console.log(fails.length ? `ROUND LOOP CHECK FAIL (${fails.length})` : "ROUND LOOP CHECK PASS");
process.exit(fails.length ? 1 : 0);
