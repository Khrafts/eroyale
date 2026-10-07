// TEMPORARY stand-in for shared/duel.ts (being written by the duel-sim track). Same exported signatures as CLAUDE.md
// "Stickman Duel" > "Rules"; follows the move table closely enough to play. Deleted once shared/duel.ts lands in
// feat/duel; nothing outside components/duel/sim.ts imports it.
export type Bits = number;
export type Fighter = { x: number; y: number; vx: number; vy: number; hp: number; facing: 1 | -1; act: string; frame: number; combo: number; hit: boolean; airUsed: boolean; rounds: number };
export type DuelState = { tick: number; round: number; roundTick: number; pause: number; f: [Fighter, Fighter]; over: boolean; winner: 0 | 1 | null };

const L = 1, R = 2, U = 4, D = 8, A = 16, B = 32;
const ROUND = 1800, PAUSE = 90, MINX = 500, MAXX = 11500, GAP = 600;
type Move = { s: number; a: number; r: number; dmg: number; reach: number; h: "mid" | "low" | "high" | "throw"; hs: number; bs: number; chip: number };
const MOVES: Record<string, Move> = {
  jab: { s: 4, a: 2, r: 7, dmg: 5, reach: 1000, h: "mid", hs: 14, bs: 9, chip: 0 },
  heavy: { s: 9, a: 3, r: 16, dmg: 12, reach: 1250, h: "mid", hs: 20, bs: 12, chip: 2 },
  sweep: { s: 8, a: 3, r: 18, dmg: 9, reach: 1300, h: "low", hs: 18, bs: 12, chip: 1 },
  air: { s: 5, a: 999, r: 0, dmg: 8, reach: 900, h: "high", hs: 16, bs: 8, chip: 1 },
  throw: { s: 3, a: 2, r: 22, dmg: 12, reach: 800, h: "throw", hs: 0, bs: 0, chip: 0 },
};
const FREE = new Set(["idle", "walk", "back", "crouch", "block", "cblock"]);

const fighter = (x: number, facing: 1 | -1, rounds: number): Fighter => ({ x, y: 0, vx: 0, vy: 0, hp: 100, facing, act: "idle", frame: 0, combo: 0, hit: false, airUsed: false, rounds });
export function initDuel(): DuelState {
  return { tick: 0, round: 1, roundTick: 0, pause: PAUSE, f: [fighter(4000, 1, 0), fighter(8000, -1, 0)], over: false, winner: null };
}

function act(f: Fighter, a: string, frame = 0) {
  f.act = a;
  f.frame = frame;
  f.hit = false;
}

function control(f: Fighter, o: Fighter, bits: Bits) {
  const m = MOVES[f.act];
  // jab recovery cancels into heavy or sweep once it connected
  if (f.act === "jab" && f.hit && f.frame >= m.s + m.a && bits & B) return act(f, bits & D ? "sweep" : "heavy");
  if (m && f.act !== "air") {
    f.frame++;
    if (f.frame >= m.s + m.a + m.r) act(f, "idle");
    return;
  }
  if (f.act === "hstun" || f.act === "bstun" || f.act === "down" || f.act === "land") {
    f.frame--;
    if (f.frame <= 0) {
      if (f.act === "hstun") f.combo = 0;
      act(f, "idle");
    }
    return;
  }
  if (f.y > 0 || f.act === "jump" || f.act === "air") {
    if (f.act === "air") f.frame++;
    if (f.act === "jump" && bits & (A | B) && !f.airUsed) {
      f.airUsed = true;
      act(f, "air");
    }
    return;
  }
  if (!FREE.has(f.act)) return;
  f.facing = o.x >= f.x ? 1 : -1;
  const fw = f.facing === 1 ? R : L;
  const bk = f.facing === 1 ? L : R;
  if ((bits & (A | B)) === (A | B)) return act(f, "throw");
  if (bits & B) return act(f, bits & D ? "sweep" : "heavy");
  if (bits & A) return act(f, "jab");
  if (bits & U) {
    act(f, "jump");
    f.vy = 200;
    f.vx = bits & R ? 60 : bits & L ? -60 : 0;
    f.y = 1;
    f.airUsed = false;
    return;
  }
  if (bits & D) return void (f.act !== (bits & bk ? "cblock" : "crouch") && act(f, bits & bk ? "cblock" : "crouch"));
  if (bits & bk) {
    if (f.act !== "block") act(f, "block");
    f.x -= 50 * f.facing;
    return;
  }
  if (bits & fw) {
    if (f.act !== "walk") act(f, "walk");
    else f.frame++;
    f.x += 70 * f.facing;
    return;
  }
  if (f.act !== "idle") act(f, "idle");
  else f.frame++;
}

function physics(f: Fighter) {
  if (f.y <= 0 && f.vy === 0) return;
  f.x += f.vx;
  f.y += f.vy;
  f.vy -= 14;
  if (f.y <= 0) {
    f.y = 0;
    f.vy = 0;
    f.vx = 0;
    if (f.act === "jump" || f.act === "air") act(f, "land", 6);
  }
}

type Hit = { d: 0 | 1; m: Move; name: string };
function hits(s: DuelState): Hit[] {
  const out: Hit[] = [];
  for (const i of [0, 1] as const) {
    const a = s.f[i], d = s.f[1 - i];
    const m = MOVES[a.act];
    if (!m || a.hit) continue;
    if (a.frame < m.s || a.frame >= m.s + m.a) continue;
    const dist = (d.x - a.x) * a.facing;
    if (dist < 0 || dist > m.reach) continue;
    if (d.act === "down") continue;
    if ((m.h === "low" || m.h === "throw") && d.y > 0) continue;
    if (d.y >= 900) continue;
    out.push({ d: (1 - i) as 0 | 1, m, name: a.act });
    a.hit = true;
  }
  return out;
}

function apply(s: DuelState, h: Hit) {
  const d = s.f[h.d], a = s.f[1 - h.d];
  const blocks = h.m.h !== "throw" && d.y === 0 && ((d.act === "block" && h.m.h !== "low") || (d.act === "cblock" && h.m.h !== "high") || d.act === "bstun");
  if (blocks) {
    d.hp -= h.m.chip;
    act(d, "bstun", h.m.bs);
  } else {
    const n = d.act === "hstun" ? d.combo + 1 : 1;
    const dmg = n >= 2 ? Math.floor((h.m.dmg * Math.max(4, 12 - 2 * n)) / 10) : h.m.dmg;
    d.combo = n;
    d.hp -= dmg;
    d.vx = 0;
    if (h.name === "sweep" || h.name === "throw") act(d, "down", 40);
    else act(d, "hstun", h.m.hs);
    if (d.y > 0) {
      d.vy = Math.min(d.vy, 0);
    }
  }
  if (h.name === "heavy") d.x += 400 * a.facing;
}

function separate(s: DuelState) {
  const [a, b] = s.f;
  for (const f of s.f) f.x = Math.max(MINX, Math.min(MAXX, f.x));
  const dx = b.x - a.x;
  if (Math.abs(dx) < GAP) {
    const push = Math.ceil((GAP - Math.abs(dx)) / 2);
    const dir = dx >= 0 ? 1 : -1;
    a.x -= push * dir;
    b.x += push * dir;
    if (a.x < MINX) { b.x += MINX - a.x; a.x = MINX; }
    if (a.x > MAXX) { b.x -= a.x - MAXX; a.x = MAXX; }
    if (b.x < MINX) { a.x += MINX - b.x; b.x = MINX; }
    if (b.x > MAXX) { a.x -= b.x - MAXX; b.x = MAXX; }
  }
}

function endRound(s: DuelState, w: 0 | 1 | null) {
  if (w !== null) s.f[w].rounds++;
  const [r0, r1] = [s.f[0].rounds, s.f[1].rounds];
  if (r0 >= 2 || r1 >= 2 || s.round >= 3) {
    s.over = true;
    s.winner = r0 > r1 ? 0 : r1 > r0 ? 1 : null;
    return;
  }
  s.round++;
  s.roundTick = 0;
  s.pause = PAUSE;
  s.f = [fighter(4000, 1, r0), fighter(8000, -1, r1)];
}

export function step(prev: DuelState, a: Bits, b: Bits): DuelState {
  const s: DuelState = { ...prev, f: [{ ...prev.f[0] }, { ...prev.f[1] }] };
  if (s.over) return s;
  s.tick++;
  if (s.pause > 0) {
    s.pause--;
    return s;
  }
  s.roundTick++;
  control(s.f[0], s.f[1], a);
  control(s.f[1], s.f[0], b);
  physics(s.f[0]);
  physics(s.f[1]);
  separate(s);
  hits(s).forEach((h) => apply(s, h));
  separate(s);
  const [f0, f1] = s.f;
  if (f0.hp <= 0 || f1.hp <= 0) endRound(s, f0.hp <= 0 && f1.hp <= 0 ? null : f0.hp <= 0 ? 1 : 0);
  else if (s.roundTick >= ROUND) endRound(s, f0.hp === f1.hp ? null : f0.hp > f1.hp ? 0 : 1);
  return s;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export const encodeInputs = (bits: Bits[]) => bits.map((x) => B64[x & 63]).join("");
export const decodeInputs = (s: string) => [...s].map((c) => B64.indexOf(c));

export function stateHash(s: DuelState): string {
  let h = 0x811c9dc5;
  const mix = (v: number | string | boolean | null) => {
    const str = String(v);
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  };
  [s.tick, s.round, s.roundTick, s.pause, s.over, s.winner].forEach(mix);
  for (const f of s.f) [f.x, f.y, f.vx, f.vy, f.hp, f.facing, f.act, f.frame, f.combo, f.hit, f.airUsed, f.rounds].forEach(mix);
  return h.toString(16).padStart(8, "0");
}

export function replay(a: string, b: string) {
  const ia = decodeInputs(a), ib = decodeInputs(b);
  let s = initDuel();
  const n = Math.max(ia.length, ib.length);
  for (let i = 0; i < n && !s.over; i++) s = step(s, ia[i] ?? 0, ib[i] ?? 0);
  return { winner: s.winner, rounds: [s.f[0].rounds, s.f[1].rounds] as [number, number], ticks: s.tick, hash: stateHash(s) };
}

export function botInput(s: DuelState, side: 0 | 1, level: 1 | 2 | 3): Bits {
  const me = s.f[side], o = s.f[1 - side];
  if (s.pause > 0 || s.over) return 0;
  const fw = me.facing === 1 ? R : L, bk = me.facing === 1 ? L : R;
  const dist = Math.abs(o.x - me.x);
  const roll = ((s.tick * 2654435761 + side * 97 + me.hp * 13) >>> 0) % 100;
  const sharp = [0, 25, 50, 80][level];
  const oMove = MOVES[o.act];
  if (oMove && o.frame < oMove.s + oMove.a && dist < oMove.reach + 200 && roll < sharp) return oMove.h === "low" ? D | bk : oMove.h === "throw" ? U | bk : bk;
  if (o.act === "hstun" && me.act === "jab" && me.hit) return B;
  if (dist < 1000 && roll < 10 + level * 6) return roll % 3 === 0 ? D | B : roll % 5 === 0 ? A | B : A;
  if (dist < 1250 && roll < 4 + level * 3) return B;
  if (dist > 1100) return roll < 4 ? U | fw : fw;
  if (roll > 92) return bk;
  return 0;
}
