// ?mock=duel&at=practice|fight|result on /duel and ?mock=duel&at=fight on /arena: a deterministic bot-against-bot
// match run through the rules (sim.ts), frozen at a moment, with no engine and no chain. Also the Dojo's mock GET
// /duels for ?mock=island&at=dojo.
import { botInput, encodeInputs, initDuel, replay, step, type DuelState } from "./sim";
import type { DuelPlayer, DuelsInfo } from "./types";

export const DUEL_MOMENTS = ["practice", "fight", "result"] as const;
export type DuelMoment = (typeof DUEL_MOMENTS)[number];

/** Side 0 is mira, side 1 is kestrel ("you" on the phone mocks): the [3, 2] bot match below is won by side 1. */
export const MOCK_PLAYERS: [DuelPlayer, DuelPlayer] = [
  { player: "0x9e2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a3c5e7b", callsign: "mira", bot: false },
  { player: "0x5a3c7e1f0b8d2a4c6e9f1b3d5a7c9e0f2b4d6a8c", callsign: "kestrel", bot: false },
];
export const MOCK_ME = 1;
export const MOCK_DUEL_ID = 12;
export const MOCK_STAKE = "5000000";

export type MockRun = { states: DuelState[]; inputs: [number[], number[]]; final: DuelState };

/** The whole match, every state kept (a match is at most ~5700 ticks). */
export function mockRun(levels: [1 | 2 | 3, 1 | 2 | 3] = [3, 2]): MockRun {
  let s = initDuel();
  const states = [s];
  const inputs: [number[], number[]] = [[], []];
  while (!s.over && s.tick < 6000) {
    const a = botInput(s, 0, levels[0]);
    const b = botInput(s, 1, levels[1]);
    inputs[0].push(a);
    inputs[1].push(b);
    s = step(s, a, b);
    states.push(s);
  }
  return { states, inputs, final: s };
}

/** A tick worth a screenshot: mid-round, a combo running, both fighters hurt; the first round with one after `from`. */
export function pickTick(run: MockRun, from: number): number {
  const st = run.states;
  for (let i = from; i < st.length; i++) {
    const s = st[i];
    if (s.pause || s.over) continue;
    const c = Math.max(s.f[0].combo, s.f[1].combo);
    if (c >= 2 && s.f[0].hp < 90 && s.f[1].hp < 90 && s.f[0].hp > 0 && s.f[1].hp > 0) return i;
  }
  for (let i = from; i < st.length; i++) if (!st[i].pause && !st[i].over) return i;
  return Math.min(from, st.length - 1);
}

export function mockReplay(run: MockRun) {
  const a = encodeInputs(run.inputs[0]);
  const b = encodeInputs(run.inputs[1]);
  return { ...replay(a, b), inputs: [a, b] as [string, string] };
}

export function mockDuels(): DuelsInfo {
  const p = (player: string, callsign: string, bot = false): DuelPlayer => ({ player, callsign, bot });
  return {
    queue: 3,
    live: [
      { duelId: 14, players: [p("0x1f4e7a2b5c8d0e3f6a9b1c4d7e0f2a5b8c1d4e7f", "orca"), p("0x7c0d3e6f9a2b5c8d1e4f7a0b3c6d9e2f5a8b1c4d", "juno")], round: 2, hp: [62, 38], ranked: true },
      { duelId: 13, players: [MOCK_PLAYERS[0], p("0x0000000000000000000000000000000000000b07", "dojo bot", true)], round: 1, hp: [80, 91], ranked: false },
    ],
    recent: [
      { duelId: 12, players: MOCK_PLAYERS, winner: MOCK_PLAYERS[1].player, rounds: [0, 2], stakeUnits: MOCK_STAKE, payoutUnits: "9500000", at: 0, settled: true, ranked: true },
      { duelId: 11, players: [p("0x3b6e9a1c4d7f0b2e5a8c1d4f7b0e3a6c9d2f5b8e", "vesper"), p("0x6d9a2c5f8b1e4a7d0c3f6b9e2a5d8c1f4b7e0a3d", "rook")], winner: "0x6d9a2c5f8b1e4a7d0c3f6b9e2a5d8c1f4b7e0a3d", rounds: [0, 2], stakeUnits: MOCK_STAKE, payoutUnits: "9500000", at: 0, settled: true, ranked: true },
      { duelId: 10, players: [p("0x8f1b4e7a0d3c6f9b2e5a8d1c4f7b0e3a6d9c2f5b", "ember"), p("0x2a5d8b1e4c7f0a3d6b9e2c5f8a1d4b7e0c3f6a9d", "slate")], winner: null, rounds: [1, 1], stakeUnits: MOCK_STAKE, payoutUnits: MOCK_STAKE, at: 0, settled: false, ranked: true },
      { duelId: 9, players: [p("0x4c7f0a3d6b9e2c5f8a1d4b7e0c3f6a9d2b5e8c1f", "pike"), p("0x0000000000000000000000000000000000000b07", "BOT", true)], winner: "0x4c7f0a3d6b9e2c5f8a1d4b7e0c3f6a9d2b5e8c1f", rounds: [2, 0], stakeUnits: "0", payoutUnits: "0", at: 0, settled: true, ranked: false },
    ],
    stakeUnits: MOCK_STAKE,
  };
}
