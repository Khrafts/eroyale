// Stickman Duel rules, shared by the engine, the browser and the CRE workflow.
// Self-contained (depends on nothing), integers only, no randomness, no clock: every runtime must
// give identical results for identical inputs. The table in CLAUDE.md "Rules: shared/duel.ts" is
// the spec; this header settles everything it leaves open. Never change these after the duel-sim
// gate first passes: a change rewrites the winner of every recorded match.
//
// Tick order. step() returns a fresh state. If `over`, it returns an unchanged copy. Otherwise
// `tick` += 1. During a pause, `pause` -= 1 and nothing else happens (inputs ignored). In a
// round, `roundTick` += 1, then: (1) each fighter updates from its own input (timers, then the
// input if free to act), (2) airborne physics, (3) walls and push-apart, (4) both fighters' hits
// are found from the same post-movement state and then applied together (so a trade lands both),
// (5) walls and push-apart again, (6) KO check, then the time limit at roundTick 1800.
//
// Inputs are levels, not edges (the state keeps no previous bits): holding A jabs again as soon
// as the fighter is free. Left and right together count as neither. "Forward" and "back" are
// relative to `facing`.
//
// Free to act: act is idle, walk, back, crouch or cblock (or any unknown act string). A free,
// grounded fighter first turns to face the opponent, then takes the first that applies:
//   A+B -> throw; down+B -> sweep; B -> heavy; A -> jab; up -> jump; down+back -> cblock
//   (crouching block, no movement); down -> crouch; back -> back (a standing block; moves 50
//   away unless the opponent is threatening, see below); forward -> walk (moves 70 toward);
//   nothing -> idle.
// Proximity guard: holding back does not move the fighter while the opponent is in an attack
// (jab, heavy, sweep, air or throw, any phase), so a held block stays in range and blocks
// instead of backing out of reach.
// So attacks beat jumping and blocking; A and B on the same tick is a throw.
// Jab cancel: during jab recovery, if the jab hit or was blocked (`hit`), B cancels into sweep
// (down held) or heavy (otherwise), whether or not A is also held.
//
// Frame counting. Moves: `frame` counts up from 0 on the tick the move starts; with startup S,
// active A, recovery R the move is active on frames S..S+A-1 and ends when frame reaches S+A+R,
// at which point the fighter is free and acts on that same tick. Stun-like acts (hitstun,
// blockstun, knockdown, land) store the ticks remaining in `frame`, counting down; at 0 the
// fighter is free and acts on that same tick. Hitstun N set on tick T ends on tick T+N.
//
// Jumping: up sets act jump, vy 200, vx +60 if right is held, -60 if left, else 0. Every tick
// while airborne (y > 0 or vy > 0, any act): x += vx, y += vy, vy -= 14. On reaching y <= 0:
// y = 0, vx = vy = 0, and a jump or air attack becomes land for 6 ticks; any other act (a fighter
// hit in the air) keeps its act and timer. Air attack: A or B while in act jump with airUsed
// false; startup 5, active from frame 5 until landing, landing recovery 6 (the land act). One
// air attack per jump; `airUsed` resets on landing.
//
// Hurtbox and reach. Only horizontal reach and the rules below decide a hit; the attacker's
// height does not matter (a fighter's hurtbox is its whole column). A move connects if the
// defender's x is in front of the attacker (same side as `facing`) and at most the move's reach
// away. A move connects at most once (`hit` set on hit or block). A defender in knockdown cannot
// be hit. An airborne defender (y > 0): low moves and throws miss; mid and high hit only if
// y < 900. Throws need the attacker grounded (they are only started grounded anyway).
//
// Blocking. Only a grounded defender blocks. A defender blocks if its act is back (standing),
// cblock (crouching) or blockstun (standing, or crouching if down is held this tick). Standing
// block stops mid and high; crouching block stops mid and low; nothing stops a throw. A blocked
// move deals its chip damage and sets blockstun; the defender holds its position. A hit deals
// damage and sets hitstun (or knockdown for 40 ticks on a sweep or throw); a hit interrupts any
// act, including the defender's own move. Heavy pushes the defender 400 in the attacker's facing
// direction on hit and on block (stopped by the wall).
//
// Combo. `combo` lives on the attacker: the number of hits in its current combo. Before hits are
// applied each tick, an attacker whose opponent is not in hitstun has combo reset to 0. A hit
// that connects (not a block) makes it combo + 1 = n; for n >= 2 damage is
// floor(dmg * max(4, 12 - 2n) / 10). A block leaves combo unchanged. hp never goes below 0.
//
// Push-apart. Positions clamp to [500, 11500]. The fighter with the smaller x is the left one
// (equal x: fighter 0 is left). If they are less than 600 apart, with gap g = 600 - distance, the
// left one moves floor(g/2) left and the right one g - floor(g/2) right; if that puts one past a
// wall it stops at the wall and the other moves the rest. Applies in the air too, so fighters
// never pass each other.
//
// Rounds. initDuel(): round 1, pause 90. Each round: fighter 0 at x 4000 facing right, fighter 1
// at 8000 facing left, hp 100, idle; round wins carry over. A round ends the tick a fighter's hp
// reaches 0 (KO, both at 0 is drawn) or at roundTick 1800 (higher hp wins, equal is drawn); the
// winner's `rounds` += 1. The match ends when a fighter has 2 round wins, or after round 3
// (more round wins takes it, equal is a drawn match, winner null). Otherwise the next round
// starts: round += 1, roundTick 0, pause 90, fighters reset. A match lasts at most 5670 ticks.
//
// replay(): steps from initDuel() with each tick's bits (0 past the end of a string) until over;
// `ticks` is the final `tick`, `hash` the final stateHash.
// stateHash(): FNV-1a 32 over the UTF-16 code units of each field written as a decimal string
// (booleans 1/0, null "n", act as its text) followed by "|", in the order tick, round,
// roundTick, pause, over, winner, then per fighter x, y, vx, vy, hp, facing, act, frame, combo,
// hit, airUsed, rounds. Lowercase hex, 8 characters.
// encodeInputs(): base64url alphabet A-Z a-z 0-9 - _, one character per tick, bits & 63.

export type Bits = number; // per tick: 1 left, 2 right, 4 up, 8 down, 16 A, 32 B
export type Fighter = { x: number; y: number; vx: number; vy: number; hp: number; facing: 1 | -1; act: string; frame: number; combo: number; hit: boolean; airUsed: boolean; rounds: number };
export type DuelState = { tick: number; round: number; roundTick: number; pause: number; f: [Fighter, Fighter]; over: boolean; winner: 0 | 1 | null };

const LEFT = 1, RIGHT = 2, UP = 4, DOWN = 8, BA = 16, BB = 32;
const STAGE_MIN = 500, STAGE_MAX = 11500, MIN_GAP = 600;
const ROUND_TICKS = 1800, PAUSE_TICKS = 90, KNOCKDOWN = 40, LAND = 6;
const FWD = 70, BACK = 50, JUMP_VY = 200, JUMP_VX = 60, GRAVITY = 14, AIR_HIT_Y = 900;

type Height = "mid" | "low" | "high" | "throw";
type Move = { s: number; a: number; r: number; dmg: number; reach: number; h: Height; hs: number; bs: number; chip: number };
const MOVES: Record<string, Move> = {
  jab: { s: 4, a: 2, r: 7, dmg: 5, reach: 1000, h: "mid", hs: 14, bs: 9, chip: 0 },
  heavy: { s: 9, a: 3, r: 16, dmg: 12, reach: 1250, h: "mid", hs: 20, bs: 12, chip: 2 },
  sweep: { s: 8, a: 3, r: 18, dmg: 9, reach: 1300, h: "low", hs: 18, bs: 12, chip: 1 },
  air: { s: 5, a: 0, r: 0, dmg: 8, reach: 900, h: "high", hs: 16, bs: 8, chip: 1 },
  throw: { s: 3, a: 2, r: 22, dmg: 12, reach: 800, h: "throw", hs: 0, bs: 0, chip: 0 },
};
const MOVE_NAMES = ["jab", "heavy", "sweep", "air", "throw"];
function isMove(act: string): boolean {
  return MOVE_NAMES.indexOf(act) >= 0;
}
const COUNTDOWN = ["hitstun", "blockstun", "knockdown", "land"];

function freshFighter(side: 0 | 1, rounds: number): Fighter {
  return { x: side === 0 ? 4000 : 8000, y: 0, vx: 0, vy: 0, hp: 100, facing: side === 0 ? 1 : -1, act: "idle", frame: 0, combo: 0, hit: false, airUsed: false, rounds };
}

export function initDuel(): DuelState {
  return { tick: 0, round: 1, roundTick: 0, pause: PAUSE_TICKS, f: [freshFighter(0, 0), freshFighter(1, 0)], over: false, winner: null };
}

function copy(s: DuelState): DuelState {
  return { tick: s.tick, round: s.round, roundTick: s.roundTick, pause: s.pause, f: [{ ...s.f[0] }, { ...s.f[1] }], over: s.over, winner: s.winner };
}

function isFree(act: string): boolean {
  return !isMove(act) && act !== "jump" && COUNTDOWN.indexOf(act) < 0;
}

function horiz(bits: Bits): number {
  const l = (bits & LEFT) !== 0, r = (bits & RIGHT) !== 0;
  return l === r ? 0 : r ? 1 : -1;
}

function startMove(f: Fighter, act: string): void {
  f.act = act; f.frame = 0; f.hit = false;
}

// The opponent is in an attack (any phase: startup, active or recovery).
function threatened(o: Fighter): boolean {
  return isMove(o.act);
}

// Free, grounded fighter acting on its input.
function act(f: Fighter, o: Fighter, bits: Bits): void {
  if (o.x !== f.x) f.facing = o.x > f.x ? 1 : -1;
  const h = horiz(bits);
  const down = (bits & DOWN) !== 0;
  const fwd = h === f.facing, back = h === -f.facing;
  if ((bits & BA) && (bits & BB)) return startMove(f, "throw");
  if (bits & BB) return startMove(f, down ? "sweep" : "heavy");
  if (bits & BA) return startMove(f, "jab");
  if (bits & UP) { f.act = "jump"; f.frame = 0; f.hit = false; f.airUsed = false; f.vy = JUMP_VY; f.vx = h * JUMP_VX; return; }
  f.frame = 0;
  if (down) { f.act = back ? "cblock" : "crouch"; return; }
  if (back) { f.act = "back"; if (!threatened(o)) f.x -= f.facing * BACK; return; }
  if (fwd) { f.act = "walk"; f.x += f.facing * FWD; return; }
  f.act = "idle";
}

function update(f: Fighter, o: Fighter, bits: Bits): void {
  if (COUNTDOWN.indexOf(f.act) >= 0) {
    f.frame -= 1;
    if (f.frame > 0) return;
    f.act = "idle"; f.frame = 0;
  } else if (f.act === "air") {
    f.frame += 1;
    return;
  } else if (f.act === "jump") {
    f.frame += 1;
    if (!f.airUsed && (bits & (BA | BB))) { startMove(f, "air"); f.airUsed = true; }
    return;
  } else if (isMove(f.act)) {
    const m = MOVES[f.act];
    f.frame += 1;
    if (f.act === "jab" && f.hit && f.frame >= m.s + m.a && f.frame < m.s + m.a + m.r && (bits & BB)) {
      startMove(f, (bits & DOWN) ? "sweep" : "heavy");
      return;
    }
    if (f.frame < m.s + m.a + m.r) return;
    f.act = "idle"; f.frame = 0;
  }
  if (f.y > 0 || f.vy > 0) return; // airborne and free: nothing to do until landing
  act(f, o, bits);
}

function physics(f: Fighter): void {
  if (f.y <= 0 && f.vy <= 0) return;
  f.x += f.vx; f.y += f.vy; f.vy -= GRAVITY;
  if (f.y <= 0) {
    f.y = 0; f.vx = 0; f.vy = 0; f.airUsed = false;
    if (f.act === "jump" || f.act === "air") { f.act = "land"; f.frame = LAND; f.hit = false; }
  }
}

function clampX(x: number): number {
  return x < STAGE_MIN ? STAGE_MIN : x > STAGE_MAX ? STAGE_MAX : x;
}

function separate(s: DuelState): void {
  const a = s.f[0], b = s.f[1];
  a.x = clampX(a.x); b.x = clampX(b.x);
  const L = b.x < a.x ? b : a, R = L === a ? b : a;
  const d = R.x - L.x;
  if (d >= MIN_GAP) return;
  const g = MIN_GAP - d, half = Math.floor(g / 2);
  L.x -= half; R.x += g - half;
  if (L.x < STAGE_MIN) { R.x += STAGE_MIN - L.x; L.x = STAGE_MIN; }
  if (R.x > STAGE_MAX) { L.x -= R.x - STAGE_MAX; R.x = STAGE_MAX; }
}

type Hit = { def: 0 | 1; m: Move; name: string; blocked: boolean };

function findHit(s: DuelState, i: 0 | 1, defBits: Bits): Hit | null {
  const f = s.f[i], d = s.f[1 - i];
  if (!isMove(f.act) || f.hit) return null;
  const m = MOVES[f.act];
  const active = f.act === "air" ? f.frame >= m.s : f.frame >= m.s && f.frame < m.s + m.a;
  if (!active) return null;
  const dx = (d.x - f.x) * f.facing;
  if (dx < 0 || dx > m.reach) return null;
  if (d.act === "knockdown") return null;
  if (d.y > 0) {
    if (m.h === "low" || m.h === "throw") return null;
    if (d.y >= AIR_HIT_Y) return null;
  }
  if (m.h === "throw" && f.y > 0) return null;
  let blocked = false;
  if (d.y === 0 && m.h !== "throw") {
    let stand = false, crouch = false;
    if (d.act === "back") stand = true;
    else if (d.act === "cblock") crouch = true;
    else if (d.act === "blockstun") { if (defBits & DOWN) crouch = true; else stand = true; }
    if (stand && (m.h === "mid" || m.h === "high")) blocked = true;
    if (crouch && (m.h === "mid" || m.h === "low")) blocked = true;
  }
  return { def: (1 - i) as 0 | 1, m, name: f.act, blocked };
}

function applyHit(s: DuelState, h: Hit): void {
  const att = s.f[1 - h.def], d = s.f[h.def];
  const m = h.m;
  att.hit = true;
  if (h.blocked) {
    d.hp -= m.chip;
    d.act = "blockstun"; d.frame = m.bs;
  } else {
    const n = att.combo + 1;
    att.combo = n;
    const dmg = n >= 2 ? Math.floor((m.dmg * Math.max(4, 12 - 2 * n)) / 10) : m.dmg;
    d.hp -= dmg;
    if (h.name === "sweep" || h.name === "throw") { d.act = "knockdown"; d.frame = KNOCKDOWN; }
    else { d.act = "hitstun"; d.frame = m.hs; }
    d.hit = false;
    if (d.y === 0) { d.vx = 0; d.vy = 0; } else { d.vx = 0; }
  }
  if (h.name === "heavy") d.x += att.facing * 400;
  if (d.hp < 0) d.hp = 0;
}

function endRound(s: DuelState, w: 0 | 1 | null): void {
  if (w !== null) s.f[w].rounds += 1;
  const r0 = s.f[0].rounds, r1 = s.f[1].rounds;
  if (r0 >= 2 || r1 >= 2 || s.round >= 3) {
    s.over = true;
    s.winner = r0 > r1 ? 0 : r1 > r0 ? 1 : null;
    return;
  }
  s.round += 1; s.roundTick = 0; s.pause = PAUSE_TICKS;
  s.f = [freshFighter(0, r0), freshFighter(1, r1)];
}

export function step(s: DuelState, a: Bits, b: Bits): DuelState {
  const n = copy(s);
  if (n.over) return n;
  n.tick += 1;
  if (n.pause > 0) { n.pause -= 1; return n; }
  n.roundTick += 1;
  const bits: [Bits, Bits] = [a & 63, b & 63];
  update(n.f[0], n.f[1], bits[0]);
  update(n.f[1], n.f[0], bits[1]);
  physics(n.f[0]); physics(n.f[1]);
  separate(n);
  if (n.f[1].act !== "hitstun") n.f[0].combo = 0;
  if (n.f[0].act !== "hitstun") n.f[1].combo = 0;
  const h0 = findHit(n, 0, bits[1]), h1 = findHit(n, 1, bits[0]);
  if (h0) applyHit(n, h0);
  if (h1) applyHit(n, h1);
  separate(n);
  const hp0 = n.f[0].hp, hp1 = n.f[1].hp;
  if (hp0 <= 0 || hp1 <= 0) endRound(n, hp0 <= 0 && hp1 <= 0 ? null : hp0 <= 0 ? 1 : 0);
  else if (n.roundTick >= ROUND_TICKS) endRound(n, hp0 > hp1 ? 0 : hp1 > hp0 ? 1 : null);
  return n;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function encodeInputs(bits: Bits[]): string {
  let out = "";
  for (const v of bits) out += B64[v & 63];
  return out;
}

export function decodeInputs(s: string): Bits[] {
  const out: Bits[] = [];
  for (let i = 0; i < s.length; i++) {
    const v = B64.indexOf(s[i]);
    if (v < 0) throw new Error(`bad input character at ${i}`);
    out.push(v);
  }
  return out;
}

export function stateHash(s: DuelState): string {
  let h = 0x811c9dc5;
  const put = (v: string): void => {
    const t = v + "|";
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  const num = (v: number): void => put(String(v));
  const bool = (v: boolean): void => put(v ? "1" : "0");
  num(s.tick); num(s.round); num(s.roundTick); num(s.pause); bool(s.over); put(s.winner === null ? "n" : String(s.winner));
  for (const f of s.f) {
    num(f.x); num(f.y); num(f.vx); num(f.vy); num(f.hp); num(f.facing); put(f.act); num(f.frame); num(f.combo); bool(f.hit); bool(f.airUsed); num(f.rounds);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const MAX_TICKS = 3 * ROUND_TICKS + 3 * PAUSE_TICKS;

export function replay(a: string, b: string): { winner: 0 | 1 | null; rounds: [number, number]; ticks: number; hash: string } {
  const ia = decodeInputs(a), ib = decodeInputs(b);
  let s = initDuel();
  while (!s.over && s.tick < MAX_TICKS) {
    const i = s.tick;
    s = step(s, i < ia.length ? ia[i] : 0, i < ib.length ? ib[i] : 0);
  }
  return { winner: s.winner, rounds: [s.f[0].rounds, s.f[1].rounds], ticks: s.tick, hash: stateHash(s) };
}

// Bots. Deterministic from the state only.
// Level 1 walks in and jabs. Level 2 also blocks on reaction (crouching against a sweep) and
// punishes with jab into heavy. Level 3 adds a mix of high (jump-in air attack), low (sweep) and
// throw, chosen by a hash of the round and a coarse time bucket.
function mix(s: DuelState, side: number): number {
  let h = Math.imul(s.round * 7919 + Math.floor(s.roundTick / 40) * 104729 + side * 31337, 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  return h % 4;
}

export function botInput(s: DuelState, side: 0 | 1, level: 1 | 2 | 3): Bits {
  if (s.over || s.pause > 0) return 0;
  const me = s.f[side], op = s.f[1 - side];
  const dir = op.x > me.x ? 1 : -1;
  const toward = dir === 1 ? RIGHT : LEFT, away = dir === 1 ? LEFT : RIGHT;
  const dist = op.x > me.x ? op.x - me.x : me.x - op.x;

  if (me.act === "jump") return dist <= 900 && me.y < 1200 ? BA : 0;
  if (level >= 2) {
    // Punish: jab into heavy once the jab has connected.
    if (me.act === "jab" && me.hit) return BB;
    // Block on reaction to a move that can reach.
    if (isMove(op.act) && op.act !== "throw" && !op.hit && isFree(me.act) && me.y === 0) {
      const m = MOVES[op.act];
      const live = op.act === "air" || op.frame < m.s + m.a;
      if (live && dist <= m.reach + 150) return op.act === "sweep" ? away | DOWN : away;
    }
    if (me.act === "blockstun") return away;
    // Whiff or blocked-move punish: the opponent is recovering in range.
    if (isMove(op.act) && op.act !== "air" && isFree(me.act) && me.y === 0) {
      const m = MOVES[op.act];
      if (op.frame >= m.s + m.a && dist <= 950) return BA;
    }
    // Sometimes hold a block in range instead of jabbing first, to punish.
    if (isFree(op.act) && dist <= 1000 && isFree(me.act) && mix(s, side + 4) === 1) return away;
  }
  if (level === 3 && isFree(me.act) && me.y === 0) {
    const r = mix(s, side);
    if (r === 1 && dist <= 780) return BA | BB;
    if (r === 2 && dist <= 1250) return DOWN | BB;
    if (r === 3 && dist > 1100 && dist <= 1500) return UP | toward;
  }
  if (dist <= 950) return BA;
  // Levels 2 and 3 sometimes hold just outside jab range for the opponent to commit.
  if (level >= 2 && dist <= 1150 && isFree(op.act) && mix(s, side + 2) === 0) return 0;
  return toward;
}
