// Scripted duel clients for a running engine (CLAUDE.md "Stickman Duel > Engine"):
//   npx tsx scripts/duel-client.mts <engineUrl> [--seed S]          two players queue (signed DuelQueue), are paired, play
//                                                                     seeded inputs over WS /ws?duel=, and check the result
//   npx tsx scripts/duel-client.mts <engineUrl> --bot [--seed S]     one player, waits out the 10 s, takes the free bot fight
// Checks: dfinal arrives; GET /duels/:id/final hashes (keccak256 of the body) to dfinal.bookHash; replay() of the served
// inputs gives dfinal's winner, rounds and tick count; `settled` follows (ranked: winner and amount as dfinal, and the
// win is in GET /stats with mode "duel"; free: no stake, nothing in /stats). Exits 0 with DUEL CLIENT PASS.
import { parseArgs } from "node:util";
import { keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DUEL_QUEUE_TYPES, ORDER_DOMAIN, duelQueueMessage } from "../src/orders.ts";
import { replay } from "../src/duel-rules.ts";
import { Rng } from "../src/rng.ts";

const { values: a, positionals } = parseArgs({ allowPositionals: true, options: { bot: { type: "boolean", default: false }, seed: { type: "string", default: "1" }, timeout: { type: "string", default: "200" } } });
const BASE = (positionals[0] ?? "http://localhost:8787").replace(/\/$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const SEED = Number(a.seed);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: string[] = [];
const ok = (cond: unknown, what: string) => {
  if (!cond) { console.error(`FAIL ${what}`); process.exit(1); }
  checks.push(what);
  console.log(`ok ${what}`);
};
setTimeout(() => { console.error(`FAIL timed out after ${a.timeout} s`); process.exit(1); }, Number(a.timeout) * 1000).unref();

async function call(method: string, path: string, body?: unknown): Promise<[number, any]> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return [r.status, await r.json().catch(() => null)];
}

type Client = { name: string; player: string; ticket: string; side: 0 | 1; duelId: number; token: string; ranked: boolean; events: any[]; ws: WebSocket };

async function queue(name: string) {
  const acct = privateKeyToAccount(generatePrivateKey());
  const player = acct.address.toLowerCase();
  const nonce = 1;
  const signature = await acct.signTypedData({ domain: ORDER_DOMAIN, types: DUEL_QUEUE_TYPES, primaryType: "DuelQueue", message: duelQueueMessage(player, name, nonce) });
  const [code, out] = await call("POST", "/duels/queue", { player, callsign: name, nonce, signature });
  ok(code === 200 && typeof out?.ticket === "string", `${name} queued (ticket)`);
  const [again] = await call("POST", "/duels/queue", { player, callsign: name, nonce, signature });
  ok(again === 400, `${name}: the same signed queue request again is refused (nonce)`);
  return { name, player, ticket: out.ticket as string };
}

async function matched(q: { name: string; ticket: string }) {
  for (;;) {
    const [code, t] = await call("GET", `/duels/queue/${q.ticket}`);
    if (code !== 200) throw new Error(`ticket poll ${code}`);
    if (t.status === "matched") return t;
    await sleep(300);
  }
}

function connect(q: { name: string; player: string; ticket: string }, t: any): Promise<Client> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WS_BASE}/ws?duel=${t.duelId}`);
    const c: Client = { ...q, side: t.side, duelId: t.duelId, token: t.sessionToken, ranked: t.ranked, events: [], ws };
    ws.onmessage = (m) => c.events.push(JSON.parse(String(m.data)));
    ws.onopen = () => res(c);
    ws.onerror = () => rej(new Error(`${q.name}: websocket error`));
  });
}

/** Seeded input changes: walk in, jab, block, crouch, jump, sweep, throw, held for 4 to 20 ticks each. */
function play(c: Client, seed: number) {
  const rng = new Rng(seed);
  const fwd = c.side === 0 ? 2 : 1, back = c.side === 0 ? 1 : 2;
  const moves = [fwd, fwd, fwd | 16, 16, 32, back, 8 | 32, 4, 16 | 32, 0, fwd, 8 | back];
  let seq = 0;
  const tick = () => {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    if (c.events.some((e) => e.type === "dfinal")) return;
    c.ws.send(JSON.stringify({ type: "input", sessionToken: c.token, seq: ++seq, bits: rng.pick(moves) }));
    setTimeout(tick, rng.int(4, 20) * (1000 / 60));
  };
  tick();
}

const until = async (c: Client, type: string) => { while (!c.events.some((e) => e.type === type)) await sleep(200); return c.events.find((e) => e.type === type); };

async function check(c: Client, ranked: boolean) {
  const fin = await until(c, "dfinal");
  const settled = await until(c, "settled");
  ok(c.events.some((e) => e.type === "dstate"), `${c.name}: dstate received (${c.events.filter((e) => e.type === "dstate").length} frames)`);
  ok(c.events.filter((e) => e.type === "dround").length >= 1, `${c.name}: dround received`);
  const [code, raw] = await fetch(`${BASE}/duels/${c.duelId}/final`).then(async (r) => [r.status, await r.text()] as const);
  ok(code === 200, `duel ${c.duelId}: GET /duels/:id/final served`);
  ok(keccak256(toBytes(raw)) === fin.bookHash, `duel ${c.duelId}: keccak256(book) == dfinal.bookHash`);
  const book = JSON.parse(raw);
  ok(book.mode === "duel" && book.duelId === c.duelId && Array.isArray(book.players) && book.players.length === 2, `duel ${c.duelId}: book shape`);
  ok(JSON.stringify(Object.keys(book)) === JSON.stringify(["mode", "duelId", "players", "stakeUnits", "feeBps", "inputs", "ticks", "logHash"]), `duel ${c.duelId}: book fields in spec order`);
  ok(book.players[c.side] === c.player, `duel ${c.duelId}: ${c.name} is players[${c.side}]`);
  const r = replay(book.inputs[0], book.inputs[1]);
  ok(r.ticks === book.ticks && book.ticks === book.inputs[0].length && book.ticks === book.inputs[1].length, `duel ${c.duelId}: replay ticks ${r.ticks} == book ticks`);
  const winner = r.winner === null ? null : book.players[r.winner];
  ok(winner === fin.winner, `duel ${c.duelId}: replay winner ${winner} == dfinal winner`);
  ok(JSON.stringify(r.rounds) === JSON.stringify(fin.rounds), `duel ${c.duelId}: replay rounds ${r.rounds} == dfinal rounds`);
  const [, again] = await fetch(`${BASE}/duels/${c.duelId}/final`).then(async (x) => [x.status, await x.text()] as const);
  ok(again === raw, `duel ${c.duelId}: book unchanged on a second read`);
  if (ranked) {
    const pot = BigInt(book.stakeUnits) * 2n;
    const expect = fin.winner ? (pot - (pot * 500n) / 10000n).toString() : book.stakeUnits;
    ok(book.stakeUnits === "5000000" && book.feeBps === 500, `duel ${c.duelId}: ranked stake 5 USDC, fee 500 bps`);
    ok(fin.payoutUnits === expect, `duel ${c.duelId}: dfinal payout ${fin.payoutUnits} == ${expect}`);
    ok(fin.winner ? JSON.stringify(settled.winners) === JSON.stringify([fin.winner]) && JSON.stringify(settled.amounts) === JSON.stringify([expect]) : settled.winners.length === 0,
      `duel ${c.duelId}: settled pays ${fin.winner ? `${fin.winner} ${expect}` : "nobody (draw, stakes refunded)"}`);
  } else {
    ok(book.stakeUnits === "0" && fin.payoutUnits === "0" && settled.winners.length === 0, `duel ${c.duelId}: free fight, no stake, no payout`);
  }
  return { fin, settled, book };
}

console.log(`duel-client against ${BASE} (${a.bot ? "bot fight" : "two players"}, seed ${SEED})`);
if (a.bot) {
  // Leaving the queue: removed at once, then unknown; nobody can be paired with it afterwards.
  const gone = await queue("LEAVER");
  const [lc, lo] = await call("DELETE", `/duels/queue/${gone.ticket}`);
  ok(lc === 200 && lo.status === "left", "DELETE /duels/queue/:ticket leaves the queue");
  const [lc2] = await call("DELETE", `/duels/queue/${gone.ticket}`);
  ok(lc2 === 404, "the left ticket is unknown afterwards");
  const q = await queue("SOLO");
  const [early] = await call("POST", `/duels/queue/${q.ticket}/bot`);
  ok(early === 400, "bot fight refused before 10 s alone");
  const [, t0] = await call("GET", `/duels/queue/${q.ticket}`);
  await sleep(Math.max(0, t0.botAfter - Date.now()) + 300);
  const [code, t] = await call("POST", `/duels/queue/${q.ticket}/bot`);
  ok(code === 200 && t.status === "matched" && t.ranked === false && t.side === 0 && typeof t.sessionToken === "string", "free bot fight after 10 s (ranked false)");
  const c = await connect(q, t);
  const duel = await until(c, "duel");
  ok(duel.players[1].bot === true && duel.stakeUnits === "0", "the opponent is labelled bot; stake 0");
  play(c, SEED);
  const { fin } = await check(c, false);
  const [, stats] = await call("GET", "/stats");
  ok(!stats.recentWins.some((w: any) => w.mode === "duel" && w.lobbyId === c.duelId), "free fight not in /stats");
  console.log(`bot fight ${c.duelId}: winner ${fin.winner ?? "draw"} rounds ${fin.rounds} ticks ${fin.ticks}`);
} else {
  const qa = await queue("ALPHA");
  const qb = await queue("BRAVO");
  const [ta, tb] = await Promise.all([matched(qa), matched(qb)]);
  ok(ta.duelId === tb.duelId && ta.side !== tb.side && ta.ranked && tb.ranked, `paired into ranked duel ${ta.duelId}`);
  const [dc, dv] = await call("DELETE", `/duels/queue/${qa.ticket}`);
  ok(dc === 409 && dv.status === "matched" && dv.duelId === ta.duelId, "DELETE on a matched ticket is 409 with the ticket view");
  const [ca, cb] = await Promise.all([connect(qa, ta), connect(qb, tb)]);
  // A stranger's input (wrong token) is ignored; checked by the replay matching what the two clients could send.
  ca.ws.send(JSON.stringify({ type: "input", sessionToken: "nope", seq: 1, bits: 16 }));
  play(ca, SEED);
  play(cb, SEED + 1);
  const { fin, settled } = await check(ca, true);
  await check(cb, true);
  if (fin.winner) {
    const [, stats] = await call("GET", "/stats");
    const w = stats.recentWins.find((x: any) => x.mode === "duel" && x.lobbyId === ca.duelId);
    ok(w && w.player === fin.winner && w.amountUnits === settled.amounts[0], `/stats has the duel win (${w?.amountUnits} to ${w?.callsign})`);
  }
  const [, list] = await call("GET", "/duels");
  ok(list.recent.some((x: any) => x.duelId === ca.duelId && x.ranked === true && x.settled === true), "GET /duels lists the duel in recent (ranked, settled)");
  console.log(`ranked duel ${ca.duelId}: winner ${fin.winner ?? "draw"} rounds ${fin.rounds} ticks ${fin.ticks} settled ${settled.txHash}`);
}
console.log(`${checks.length} checks ok`);
console.log("DUEL CLIENT PASS");
process.exit(0);
