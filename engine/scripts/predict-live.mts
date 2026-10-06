// Live check of prediction mode against a running engine (npm run dev -- --predict-bots 10, CHAIN=off works).
// Watches protocol rounds over the WebSocket until two reach `final`, and creates a signed user round with four
// burner players that must reach `final` too. Also probes the refusals (bad signature, out of range, reused nonce,
// non-player, after the lock). Exits 0 when all of that happened.
// npx tsx scripts/predict-live.mts [baseUrl]
import WebSocket from "ws";
import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CREATE_ROUND_TYPES, JOIN_TYPES, ORDER_DOMAIN, PREDICTION_TYPES, createRoundMessage, joinMessage, predictionMessage } from "../src/orders.ts";

const base = process.argv[2] ?? `http://localhost:${process.env.PORT ?? 8787}`;
const wsBase = base.replace(/^http/, "ws");
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (m: string) => console.log(`${stamp()} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (p: string) => (await fetch(base + p)).json();
const post = async (p: string, b: unknown): Promise<[number, any]> => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return [r.status, await r.json()];
};
const fails: string[] = [];
const expect = (what: string, ok: boolean, detail: unknown) => { say(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(detail)}`); if (!ok) fails.push(what); };

const finals = new Map<number, { protocol: boolean; final: any }>();
const watching = new Set<number>();
function watch(id: number, protocol: boolean) {
  if (watching.has(id)) return;
  watching.add(id);
  const ws = new WebSocket(`${wsBase}/ws?lobby=${id}`);
  let pticks = 0;
  ws.on("message", async (data) => {
    const e = JSON.parse(data.toString());
    if (e.type === "round") say(`[${id}] round ${e.params.market} protocol=${e.protocol} lock ${e.lockTime} end ${e.endTime} split ${e.params.split} creator ${e.params.creator}`);
    else if (e.type === "locked") say(`[${id}] locked at t=${e.t} with ${e.predictions.length} predictions`);
    else if (e.type === "ptick") { if (pticks++ % 120 === 0) say(`[${id}] ptick t=${e.t} mark ${e.mark} band ${e.band.low}-${e.band.high} leader ${e.leaders[0]?.player.slice(0, 8)} d=${e.leaders[0]?.distance}`); }
    else if (e.type === "cancelled") say(`[${id}] cancelled: ${e.reason}`);
    else if (e.type === "final" && !finals.has(id)) {
      const bytes = new Uint8Array(await (await fetch(`${base}/lobbies/${id}/final`)).arrayBuffer());
      const hashOk = keccak256(bytes) === e.bookHash;
      finals.set(id, { protocol, final: e });
      say(`[${id}] FINAL settlement ${e.settlementPrice}, ${e.winners.length} winners, pticks seen ${pticks}, creatorFeeUnits ${e.creatorFeeUnits}, bookHash matches GET final: ${hashOk}`);
      for (const w of e.winners) say(`[${id}]   #${w.rank} ${w.callsign} ${w.price} d=${w.distance} -> ${w.provisionalPayoutUnits}`);
      if (!hashOk) fails.push(`bookHash ${id}`);
    }
  });
}

// ---------- the user round
const creator = privateKeyToAccount(generatePrivateKey());
const rs = await get("/rounds");
const mark = rs.rounds[0]?.mark ?? (await get("/marks")).marks?.ETH;
const params = {
  creator: creator.address.toLowerCase(), market: "ETH", entryUnits: "2000000", maxPlayers: 8, lockAfter: 30, resolveAfter: 60,
  winnerBps: 5000, split: "steep", creatorFeeBps: 300,
};
const signRound = (p: typeof params, nonce: number) =>
  creator.signTypedData({ domain: ORDER_DOMAIN, types: CREATE_ROUND_TYPES, primaryType: "CreateRound", message: createRoundMessage(p, nonce) });
let r = await post("/rounds", { params, nonce: 1, signature: "0x1234" });
expect("unsigned create refused", r[0] === 401, r);
r = await post("/rounds", { params: { ...params, creatorFeeBps: 600 }, nonce: 1, signature: await signRound({ ...params, creatorFeeBps: 600 }, 1) });
expect("creatorFeeBps 600 refused", r[0] === 400, r);
r = await post("/rounds", { params: { ...params, lockAfter: 10 }, nonce: 1, signature: await signRound({ ...params, lockAfter: 10 }, 1) });
expect("lockAfter 10 refused", r[0] === 400, r);
r = await post("/rounds", { params, nonce: 1, signature: await signRound({ ...params, winnerBps: 4000 }, 1) });
expect("signature over other params refused", r[0] === 401, r);
r = await post("/rounds", { params, nonce: 1, signature: await signRound(params, 1) });
expect("signed user round created", r[0] === 200 && Number.isInteger(r[1].lobbyId), r);
const userId: number = r[1].lobbyId;
r = await post("/rounds", { params, nonce: 1, signature: await signRound(params, 1) });
expect("reused create nonce refused", r[0] === 400, r);
watch(userId, false);

const players = ["ALPHA", "BRAVO", "CHARLIE", "DELTA"].map((callsign) => ({ acct: privateKeyToAccount(generatePrivateKey()), callsign, nonce: 0 }));
const predict = async (p: (typeof players)[number], price: string, lobbyId = userId) => {
  const player = p.acct.address.toLowerCase();
  const nonce = ++p.nonce;
  const signature = await p.acct.signTypedData({ domain: ORDER_DOMAIN, types: PREDICTION_TYPES, primaryType: "Prediction", message: predictionMessage(lobbyId, player, price, nonce) });
  return post("/predictions", { lobbyId, player, price, nonce, ts: Date.now(), signature });
};
r = await predict(players[0], "100.00");
expect("prediction before joining refused", r[0] === 400, r);
for (const p of players) {
  const player = p.acct.address.toLowerCase();
  const signature = await p.acct.signTypedData({ domain: ORDER_DOMAIN, types: JOIN_TYPES, primaryType: "Join", message: joinMessage(userId, player, p.callsign) });
  r = await post(`/lobbies/${userId}/join`, { player, callsign: p.callsign, signature });
  expect(`${p.callsign} joined`, r[0] === 200, r);
}
const base0 = Number((await get(`/lobbies/${userId}`)).mark ?? mark ?? "3000");
const at = (bp: number) => (Math.round(base0 * (1 + bp / 10000) * 100) / 100).toFixed(2);
for (const [i, p] of players.entries()) {
  r = await predict(p, at((i - 1.5) * 4));
  expect(`${p.callsign} predicted`, r[0] === 200, r);
}
r = await predict(players[0], at(1));
expect("ALPHA replaced its prediction", r[0] === 200 && r[1].count === 4, r);
r = await predict(players[1], "12.3");
expect("1-decimal price refused", r[0] === 400, r);
r = await predict(players[1], "0.00");
expect("zero price refused", r[0] === 400, r);
{
  const p = players[2];
  const player = p.acct.address.toLowerCase();
  const signature = await p.acct.signTypedData({ domain: ORDER_DOMAIN, types: PREDICTION_TYPES, primaryType: "Prediction", message: predictionMessage(userId, player, at(2), p.nonce) });
  r = await post("/predictions", { lobbyId: userId, player, price: at(2), nonce: p.nonce, ts: Date.now(), signature });
  expect("reused prediction nonce refused", r[0] === 400, r);
}
const snap = await get(`/lobbies/${userId}`);
expect("no prices in the snapshot before the lock", !JSON.stringify(snap).includes(at(1)), { predictedCount: snap.predictedCount, lockTime: snap.lockTime });

// ---------- protocol rounds: watch every one that appears until two have reached final
const tLate = (await get(`/lobbies/${userId}`)).lockTime * 1000 + 1500;
let probedLate = false;
const deadline = Date.now() + 15 * 60_000;
for (;;) {
  const list = await get("/rounds");
  for (const x of [...list.rounds, ...list.active]) if (x.protocol) watch(x.lobbyId, true);
  if (!probedLate && Date.now() > tLate) {
    probedLate = true;
    r = await predict(players[3], at(3));
    expect("prediction after the lock refused", r[0] === 400, r);
  }
  const protocolFinals = [...finals.values()].filter((f) => f.protocol).length;
  if (protocolFinals >= 2 && finals.has(userId)) break;
  if (Date.now() > deadline) { fails.push("timed out"); break; }
  await sleep(2000);
}
say(`protocol rounds at final: ${[...finals.entries()].filter(([, f]) => f.protocol).map(([id]) => id).join(", ")}; user round ${userId} final: ${finals.has(userId)}`);
say(fails.length ? `FAILED: ${fails.join("; ")}` : "PREDICT LIVE PASS");
process.exit(fails.length ? 1 : 0);
