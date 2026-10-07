// TEMPORARY stand-in for shared/duel.ts (the duel-sim track) with the exported signatures from CLAUDE.md "Stickman
// Duel > Rules". Deleted once shared/duel.ts lands; engine code imports the rules only through ./duel-rules.ts.
// Deliberately crude rules (walk, jab, block); deterministic and integer-only so the engine flow can be built and tested.
export type Bits = number;
export type Fighter = { x: number; y: number; vx: number; vy: number; hp: number; facing: 1 | -1; act: string; frame: number; combo: number; hit: boolean; airUsed: boolean; rounds: number };
export type DuelState = { tick: number; round: number; roundTick: number; pause: number; f: [Fighter, Fighter]; over: boolean; winner: 0 | 1 | null };

const PAUSE = 90, ROUND = 1800;
const fighter = (x: number, facing: 1 | -1, rounds: number): Fighter => ({ x, y: 0, vx: 0, vy: 0, hp: 100, facing, act: "idle", frame: 0, combo: 0, hit: false, airUsed: false, rounds });

export function initDuel(): DuelState {
  return { tick: 0, round: 1, roundTick: 0, pause: PAUSE, f: [fighter(4000, 1, 0), fighter(8000, -1, 0)], over: false, winner: null };
}

export function step(s0: DuelState, a: Bits, b: Bits): DuelState {
  const s: DuelState = { ...s0, f: [{ ...s0.f[0] }, { ...s0.f[1] }] };
  if (s.over) return s;
  s.tick++;
  if (s.pause > 0) { s.pause--; return s; }
  s.roundTick++;
  const ins = [a, b];
  for (const i of [0, 1] as const) {
    const me = s.f[i], foe = s.f[1 - i], bits = ins[i];
    me.facing = foe.x > me.x ? 1 : -1;
    if (me.act === "jab") {
      me.frame++;
      if (me.frame === 4 && !me.hit && Math.abs(foe.x - me.x) <= 1000) {
        me.hit = true;
        const blocked = foe.act === "block";
        foe.hp -= blocked ? 0 : 5;
        me.combo = blocked ? 0 : me.combo + 1;
      }
      if (me.frame >= 13) { me.act = "idle"; me.frame = 0; me.hit = false; }
      continue;
    }
    const back = me.facing === 1 ? 1 : 2, fwd = me.facing === 1 ? 2 : 1;
    if (bits & 16) { me.act = "jab"; me.frame = 0; me.hit = false; continue; }
    if (bits & back) { me.act = "block"; me.x -= 50 * me.facing; }
    else if (bits & fwd) { me.act = "walk"; me.x += 70 * me.facing; }
    else me.act = "idle";
    me.x = Math.max(500, Math.min(11500, me.x));
  }
  if (Math.abs(s.f[1].x - s.f[0].x) < 600) {
    const mid = (s.f[0].x + s.f[1].x) >> 1, l = s.f[0].x <= s.f[1].x ? 0 : 1;
    s.f[l].x = mid - 300; s.f[1 - l].x = mid + 300;
  }
  const ko0 = s.f[0].hp <= 0, ko1 = s.f[1].hp <= 0;
  if (ko0 || ko1 || s.roundTick >= ROUND) {
    let w: 0 | 1 | null = null;
    if (ko0 !== ko1) w = ko1 ? 0 : 1;
    else if (!ko0 && s.f[0].hp !== s.f[1].hp) w = s.f[0].hp > s.f[1].hp ? 0 : 1;
    const r = [s.f[0].rounds + (w === 0 ? 1 : 0), s.f[1].rounds + (w === 1 ? 1 : 0)];
    if (r[0] >= 2 || r[1] >= 2 || s.round >= 3) {
      s.f[0].rounds = r[0]; s.f[1].rounds = r[1];
      s.over = true;
      s.winner = r[0] === r[1] ? null : r[0] > r[1] ? 0 : 1;
      return s;
    }
    s.round++; s.roundTick = 0; s.pause = PAUSE;
    s.f = [fighter(4000, 1, r[0]), fighter(8000, -1, r[1])];
  }
  return s;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function encodeInputs(bits: Bits[]): string { return bits.map((x) => B64[x & 63]).join(""); }
export function decodeInputs(s: string): Bits[] {
  return [...s].map((c) => { const i = B64.indexOf(c); if (i < 0) throw new Error(`bad input char ${c}`); return i; });
}

export function stateHash(s: DuelState): string {
  let h = 0x811c9dc5;
  const mix = (n: number) => { for (const c of String(n)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } };
  mix(s.tick); mix(s.round); mix(s.roundTick); mix(s.pause);
  for (const f of s.f) { mix(f.x); mix(f.y); mix(f.hp); mix(f.facing); mix(f.frame); mix(f.combo); mix(f.rounds); }
  mix(s.over ? 1 : 0); mix(s.winner ?? -1);
  return h.toString(16).padStart(8, "0");
}

export function replay(a: string, b: string): { winner: 0 | 1 | null; rounds: [number, number]; ticks: number; hash: string } {
  const ia = decodeInputs(a), ib = decodeInputs(b);
  let s = initDuel();
  let n = 0;
  while (!s.over && n < Math.max(ia.length, ib.length)) { s = step(s, ia[n] ?? 0, ib[n] ?? 0); n++; }
  return { winner: s.winner, rounds: [s.f[0].rounds, s.f[1].rounds], ticks: n, hash: stateHash(s) };
}

export function botInput(s: DuelState, side: 0 | 1, level: 1 | 2 | 3): Bits {
  const me = s.f[side], foe = s.f[1 - side];
  const d = Math.abs(foe.x - me.x);
  const fwd = me.facing === 1 ? 2 : 1;
  if (d <= 900 && (s.tick + side) % (8 - level * 2) === 0) return 16;
  return d > 900 ? fwd : 0;
}
