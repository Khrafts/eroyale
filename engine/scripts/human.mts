import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { JOIN_TYPES, ORDER_DOMAIN, ORDER_TYPES, joinMessage, orderMessage } from "../src/orders.ts";
const acct = privateKeyToAccount(generatePrivateKey());
const player = acct.address.toLowerCase();
const base = "http://localhost:8787";
const post = async (p: string, b: unknown) => { const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return [r.status, await r.json()]; };
console.log("join unsigned", await post("/lobbies/1/join", { player, callsign: "HUMAN" }));
const joinSig = await acct.signTypedData({ domain: ORDER_DOMAIN, types: JOIN_TYPES, primaryType: "Join", message: joinMessage(1, player, "HUMAN") });
console.log("join", await post("/lobbies/1/join", { player, callsign: "HUMAN", signature: joinSig }));
let nonce = 0;
async function order(order: any, sign = true) {
  const req: any = { lobbyId: 1, player, nonce: ++nonce, ts: Date.now(), order };
  if (sign) req.signature = await acct.signTypedData({ domain: ORDER_DOMAIN, types: ORDER_TYPES, primaryType: "Order", message: orderMessage(req) });
  else req.signature = "0x1234";
  return post("/orders", req);
}
while ((await (await fetch(base + "/lobbies/1")).json()).status !== "live") await new Promise((r) => setTimeout(r, 500));
console.log("open", await order({ action: "open", market: "BTC", side: 1, margin: "5000.00", leverage: 20 }));
console.log("open again same market", await order({ action: "open", market: "BTC", side: 1, margin: "100.00", leverage: 2 }));
console.log("bad sig", await order({ action: "open", market: "ETH", side: 1, margin: "100.00", leverage: 2 }, false));
console.log("too much margin", await order({ action: "open", market: "ETH", side: -1, margin: "9000.00", leverage: 2 }));
await new Promise((r) => setTimeout(r, 5000));
console.log("close", await order({ action: "close", market: "BTC" }));
const s = await (await fetch(base + "/lobbies/1")).json();
console.log("me", JSON.stringify(s.players.find((p: any) => p.player === player)));
