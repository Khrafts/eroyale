// Offline match: virtual clock, seeded prices and bots. Same seed, same bytes.
// npm run sim -- --bots N --preset stage|standard --seed S --out FILE --events FILE
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Lobby } from "./lobby.ts";
import { Bots, botAddress, botCallsign } from "./bots.ts";
import { RandomWalkPrices } from "./prices.ts";
import { Driver, VirtualClock } from "./driver.ts";
import { hashSeed } from "./rng.ts";
import { PRESETS, TICKS_PER_SEC, type Preset } from "./types.ts";

export const SIM_START = 1791288000 - 120; // fixed virtual start time (unix seconds)

export function runSim(nBots: number, preset: Preset, seed: number) {
  const lines: string[] = [];
  const lobby = new Lobby({ id: 1, preset, maxPlayers: 50 });
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

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) {
  const { values } = parseArgs({
    options: {
      bots: { type: "string", default: "20" }, preset: { type: "string", default: "stage" },
      seed: { type: "string", default: "1" }, out: { type: "string" }, events: { type: "string" },
    },
  });
  const preset = PRESETS[values.preset as Preset["name"]];
  if (!preset) throw new Error(`unknown preset ${values.preset}`);
  const n = Number(values.bots);
  if (!Number.isInteger(n) || n < 4 || n > 50) throw new Error("--bots must be 4 to 50");
  const { bookJson, events, lobby } = runSim(n, preset, Number(values.seed));
  if (values.out) writeFileSync(values.out, bookJson);
  if (values.events) writeFileSync(values.events, events);
  const liq = lobby.players.filter((p) => p.elimReason === "liquidated").length;
  const fin = lobby.players.filter((p) => p.alive).length;
  console.log(`sim done: ${n} bots, ${fin} finalists, ${liq} liquidated`);
}
