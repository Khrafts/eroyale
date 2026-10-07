// Offline match: virtual clock, seeded prices and bots. Same seed, same bytes.
// npm run sim -- --bots N --preset stage|standard --seed S [--zone-mode linear|relative] --out FILE --events FILE
// npm run sim -- --mode predict --bots N --seed S --market BTC|ETH|SOL [--winner-bps B --split S --creator-fee-bps F] --out FILE --events FILE
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Lobby } from "./lobby.ts";
import { Bots, botAddress, botCallsign } from "./bots.ts";
import { RandomWalkPrices } from "./prices.ts";
import { Driver, PredictDriver, VirtualClock } from "./driver.ts";
import { hashSeed } from "./rng.ts";
import { LINEAR_ZONE, MARKETS, PRESETS, TICKS_PER_SEC, type Market, type Preset, type ZoneConfig } from "./types.ts";
import { PredictRound, SPLITS, checkUserSpec, protocolSpec, type RoundSpec, type Split } from "./predict.ts";
import { PredictBots } from "./predict-bots.ts";
import { keccak256, toBytes } from "viem";

export const SIM_START = 1791288000 - 120; // fixed virtual start time (unix seconds)

export function runSim(nBots: number, preset: Preset, seed: number, zone: ZoneConfig = LINEAR_ZONE) {
  const lines: string[] = [];
  const lobby = new Lobby({ id: 1, preset, maxPlayers: 50, zone });
  lobby.onEvent((_e, line) => lines.push(line));
  lobby.emitLobby();
  const bots = new Bots(seed);
  for (let i = 0; i < nBots; i++) {
    const addr = botAddress(seed, i);
    const r = lobby.join(addr, botCallsign(i), true);
    if (!r.ok) throw new Error(`bot ${i} join: ${r.error}`);
    bots.add(addr, i);
  }
  const clock = new VirtualClock((SIM_START - 10) * 1000);
  lobby.countdown(SIM_START);
  const driver = new Driver(lobby, clock, new RandomWalkPrices(hashSeed(seed, "prices")), bots);
  while (!driver.advance()) clock.ms += 1000 / TICKS_PER_SEC;
  const { bookJson } = lobby.finalize(lobby.marks!);
  return { bookJson, events: lines.map((l) => l + "\n").join(""), lobby };
}

/** Offline prediction round, opened so that it resolves at SIM_START + 120 (a whole minute). */
export function runPredictSim(nBots: number, seed: number, spec: RoundSpec, protocol: boolean) {
  const lines: string[] = [];
  const openTime = SIM_START + 120 - spec.resolveAfter - spec.lockAfter;
  const round = new PredictRound({ id: 1, spec, protocol, openTime });
  round.onEvent((_e, line) => lines.push(line));
  round.emitLobby();
  round.emitRound();
  const t = () => Math.max(round.k, 0) / TICKS_PER_SEC;
  const bots = new PredictBots(seed, (player, price) => { round.predict(player, price, t()); });
  for (let i = 0; i < nBots; i++) {
    const addr = botAddress(seed, i);
    const r = round.join(addr, botCallsign(i), true);
    if (!r.ok) throw new Error(`bot ${i} join: ${r.error}`);
    bots.add(round, addr, i);
  }
  const clock = new VirtualClock(openTime * 1000);
  const driver = new PredictDriver(round, clock, new RandomWalkPrices(hashSeed(seed, "prices")), bots);
  while (!driver.advance() && round.status !== "cancelled") clock.ms += 1000 / TICKS_PER_SEC;
  if (round.status === "cancelled") return { bookJson: null, events: lines.map((l) => l + "\n").join(""), round };
  const bookJson = round.freezeBook();
  round.emitFinal(round.mark!);
  return { bookJson, events: lines.map((l) => l + "\n").join(""), round };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) {
  const { values } = parseArgs({
    options: {
      bots: { type: "string", default: "20" }, preset: { type: "string", default: "stage" },
      seed: { type: "string", default: "1" }, out: { type: "string" }, events: { type: "string" },
      mode: { type: "string", default: "royale" }, market: { type: "string", default: "BTC" },
      "winner-bps": { type: "string" }, split: { type: "string" }, "creator-fee-bps": { type: "string" },
      "zone-mode": { type: "string", default: "linear" },
    },
  });
  if (values.mode === "predict") {
    const n = Number(values.bots);
    if (!Number.isInteger(n) || n < 0 || n > 50) throw new Error("--bots must be 0 to 50");
    const market = values.market as Market;
    if (!MARKETS.includes(market)) throw new Error("--market must be BTC, ETH or SOL");
    const seed = Number(values.seed);
    const spec = protocolSpec(market);
    const user = values["winner-bps"] !== undefined || values.split !== undefined || values["creator-fee-bps"] !== undefined;
    if (user) {
      // A user round needs a creator; the sim derives one from the seed.
      spec.creator = "0x" + keccak256(toBytes(`royale-creator:${seed}`)).slice(26);
      if (values["winner-bps"] !== undefined) spec.winnerBps = Number(values["winner-bps"]);
      if (values.split !== undefined) {
        if (!SPLITS.includes(values.split as Split)) throw new Error("--split must be equal, linear or steep");
        spec.split = values.split as Split;
      }
      if (values["creator-fee-bps"] !== undefined) spec.creatorFeeBps = Number(values["creator-fee-bps"]);
      const err = checkUserSpec(spec);
      if (err) throw new Error(err);
    }
    const { bookJson, events, round } = runPredictSim(n, seed, spec, !user);
    if (values.out && bookJson) writeFileSync(values.out, bookJson);
    if (values.events) writeFileSync(values.events, events);
    console.log(round.status === "cancelled"
      ? `sim done: round cancelled (${round.cancelReason})`
      : `sim done: ${n} bots, ${round.predictedCount} predicted, settlement ${round.mark}, ${(round.finalEvent!.winners as unknown[]).length} winners`);
    process.exit(0);
  }
  const preset = PRESETS[values.preset as Preset["name"]];
  if (!preset) throw new Error(`unknown preset ${values.preset}`);
  const n = Number(values.bots);
  if (!Number.isInteger(n) || n < 4 || n > 50) throw new Error("--bots must be 4 to 50");
  if (values["zone-mode"] !== "linear" && values["zone-mode"] !== "relative") throw new Error("--zone-mode must be linear or relative");
  const zone: ZoneConfig = values["zone-mode"] === "relative" ? { mode: "relative", startBps: 200n, endBps: 100n } : LINEAR_ZONE;
  const { bookJson, events, lobby } = runSim(n, preset, Number(values.seed), zone);
  if (values.out) writeFileSync(values.out, bookJson);
  if (values.events) writeFileSync(values.events, events);
  const liq = lobby.players.filter((p) => p.elimReason === "liquidated").length;
  const fin = lobby.players.filter((p) => p.alive).length;
  console.log(`sim done: ${n} bots, ${fin} finalists, ${liq} liquidated`);
}
