// Stickman Duel rules, v2, shared by the engine, the browser and the CRE workflow.
// Self-contained (depends on nothing), integers only, no randomness, no clock: every runtime must
// give identical results for identical inputs. CLAUDE.md "Stickman Duel" plus "Duel tuning
// (Phase 14)" (which wins where they differ) is the spec; this header settles everything they
// leave open. Never change these after the duel-sim gate first passes: a change rewrites the
// winner of every recorded match.
//
// v2 replaced v1 on 2026-10-07, while ranked play was off (every v1 ranked duel was already
// settled on chain and nothing pending replays under v1). What v2 changed: jab hitstun 14 -> 12
// (no jab loop); push-apart only when both fighters are grounded (a jump passes over the
// opponent); landing resolution and its equal-x tie-break; air attacks hit on either side, and
// blocking one needs the hold away from the attacker's position (cross-ups); the bots. No other
// number in the move table changed.
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
// grounded fighter first turns to face the opponent (no turn at equal x), then takes the first
// that applies:
//   A+B -> throw; down+B -> sweep; B -> heavy; A -> jab; up -> jump; down+back -> cblock
//   (crouching block, no movement); down -> crouch; back -> back (moves 50 away and is a
//   standing block); forward -> walk (moves 70 toward); nothing -> idle.
// The turn is what makes a cross-up work: once the opponent is on the other side, the defender
// faces it, and "back" is away from it again.
// Side symmetry: both fighters update against a snapshot of the opponent taken before either
// update, and hits are found from one state and applied without touching the other hit's
// inputs, so swapping the sides and mirroring left and right gives the mirrored match exactly.
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
// No loops (v2). A jab that hits on its frame 4 leaves the defender in hitstun until frame 16,
// where it acts; a held A restarts the jab on frame 13, active on frame 17. So a defender
// holding back from its first free tick blocks the re-jab. Every other move leaves the attacker
// busy at least as long as the defender is stunned (heavy: hit on 9, free on 29, attacker's next
// move active no sooner than 32; sweep and throw knock down for 40 and the downed fighter cannot
// be hit, and it acts before the hits are found on the tick it gets up). Jab into heavy and jab
// into sweep are cancels and still combo (heavy active on 15, sweep on 14, defender stunned to
// 16). An air attack that hits in the last 5 ticks before its landing leaves time for a jab after
// the 6 landing ticks. Longest true combo: air, jab, then the heavy or sweep cancel (3 hits).
//
// Jumping: up sets act jump, vy 200, vx +60 if right is held, -60 if left, else 0. Every tick
// while airborne (y > 0 or vy > 0, any act): x += vx, y += vy, vy -= 14. On reaching y <= 0:
// y = 0, vx = vy = 0, and a jump or air attack becomes land for 6 ticks; any other act (a fighter
// hit in the air) keeps its act and timer. A jump is in the air for 29 ticks and lands on the
// 30th, 1740 from where it started. Air attack: A or B while in act jump with airUsed false;
// startup 5, active from frame 5 until landing, landing recovery 6 (the land act). One air
// attack per jump; `airUsed` resets on landing. The jumper keeps its facing in the air.
//
// Hurtbox and reach. Only horizontal reach and the rules below decide a hit; the attacker's
// height does not matter (a fighter's hurtbox is its whole column). A ground move connects if
// the defender's x is in front of the attacker (same side as `facing`, or equal x) and at most
// the move's reach away. An air attack connects on either side: |dx| <= 900 (v2, cross-ups). A
// move connects at most once (`hit` set on hit or block). A defender in knockdown cannot be hit.
// An airborne defender (y > 0): low moves and throws miss; mid and high hit only if y < 900.
// Throws need the attacker grounded (they are only started grounded anyway).
//
// Blocking. Only a grounded defender blocks. A defender blocks if its act is back (standing),
// cblock (crouching) or blockstun (standing, or crouching if down is held this tick). Standing
// block stops mid and high; crouching block stops mid and low; nothing stops a throw. Against an
// air attack (v2) the defender must also hold away from the attacker's position on that tick
// (after physics, so after the defender's own turn): left held when the attacker's x is greater,
// right when smaller, back relative to its own facing at equal x. So a defender holding the old
// back against a cross-up has turned into a walk and is hit; one holding away from the attacker
// blocks. A blocked move deals its chip damage and sets blockstun; the defender holds its
// position. A hit deals damage and sets hitstun (or knockdown for 40 ticks on a sweep or throw);
// a hit interrupts any act, including the defender's own move. Heavy pushes the defender 400 in
// the attacker's facing direction on hit and on block (stopped by the wall).
//
// Combo. `combo` lives on the attacker: the number of hits in its current combo. Before hits are
// applied each tick, an attacker whose opponent is not in hitstun has combo reset to 0. A hit
// that connects (not a block) makes it combo + 1 = n; for n >= 2 damage is
// floor(dmg * max(4, 12 - 2n) / 10). A block leaves combo unchanged. hp never goes below 0.
//
// Push-apart (v2). Positions clamp to [500, 11500] every time. Push-apart applies only when both
// fighters are grounded (y = 0), so an airborne fighter passes over a grounded one and they may
// overlap while one is in the air. When both are grounded and less than 600 apart (always the
// case on the tick a jumper lands close), they are separated by their order at that tick: the
// fighter with the smaller x is the left one. Equal x: the fighter facing right is the left one;
// if both face the same way, fighter 0 is the left one. Both rules give the mirrored result when
// the sides are swapped and left and right mirrored (mirroring flips both facings, and swapping
// the indices maps "fighter 0 left" onto the mirror of "fighter 1 right"), so the symmetry above
// holds. With gap g = 600 - distance, each moves ceil(g/2) away from the other (so they end 600
// or 601 apart, exactly symmetric); if that puts one past a wall it stops at the wall and the
// other moves the rest. A forward jump from 600 to 1100 apart therefore lands on the far side of
// an idle opponent and ends at least 600 from it; near a wall the clamp can stop the crossing.
//
// Rounds. initDuel(): round 1, pause 90. Each round: fighter 0 at x 4000 facing right, fighter 1
// at 8000 facing left, hp 100, idle; round wins carry over. A round ends the tick a fighter's hp
// reaches 0 (KO, both at 0 is drawn) or at roundTick 1800 (higher hp wins, equal is drawn); the
// winner's `rounds` += 1. The match ends when a fighter has 2 round wins, or after round 3
// (more round wins takes it, equal is a drawn match, winner null). Otherwise the next round
// starts: round += 1, roundTick 0, pause 90, fighters reset. A match lasts at most 5670 ticks.
//
// replay(): reads at most 5670 characters of each string and steps from initDuel() with each
// tick's bits (0 past the end of a string) until over;
// `ticks` is the final `tick`, `hash` the final stateHash.
// stateHash(): FNV-1a 32 over the UTF-16 code units of each field written as a decimal string
// (booleans 1/0, null "n", act as its text) followed by "|", in the order tick, round,
// roundTick, pause, over, winner, then per fighter x, y, vx, vy, hp, facing, act, frame, combo,
// hit, airUsed, rounds. Lowercase hex, 8 characters.
// encodeInputs(): base64url alphabet A-Z a-z 0-9 - _, one character per tick, bits & 63.
//
// Bots (v2), botInput(): deterministic from the state alone, no history. The returned bits are
// for the next step, so "now" below means roundTick + 1.
// Pacing. Each level cuts the round into cycles of P ticks (by roundTick); a string (attacks
// fewer than 10 non-attack ticks apart) may start only in the first W ticks of a cycle. Inside a
// string the bot only continues: the jab cancel, an air attack in its own jump, and a jab after
// landing while the opponent still has 6 or more hitstun ticks left (so it is a true combo).
// Every string ends at least the level's gap before the next window opens, and the shortest
// attack (13) outlasts W, so two strings never start in one window. The choices inside a window
// (which move, which cancel, whether to jump) come from mix(): a hash of the round, the cycle
// index and the side.
//   Level 1 Sparring: P 90, W 12. Walks in during the last third of the cycle, throws one jab or
//     heavy (heavy one cycle in four) in the window, hops back (a backward jump, never "back",
//     so it never blocks) if still close, then waits. Never cancels, never air attacks. Longest
//     string 1 attack (28 ticks), gap >= 90 - 12 - 28 = 50.
//   Level 2 Fighter: P 64, W 8. Reacts to a move from its frame 5: crouch-blocks a ground move
//     (no retreat), stands against an air attack holding away from the attacker, so it blocks
//     heavy, sweep and late air attacks but not a fresh jab (active on 4); in blockstun it keeps
//     the same guard. In the window: meets a walk-in with a heavy, punishes a move in recovery,
//     otherwise jabs in range and cancels into heavy or sweep on hit or block. Longest string jab
//     into a cancel (35 ticks), gap >= 64 - 8 - 35 = 21.
//   Level 3 Master: P 56, W 12, reacts from frame 2, so it also blocks a fresh jab. A throw
//     started on a jab's frame 2 is active after the jab, so "throw breaks a fresh jab" works on
//     the jab's end instead: Master blocks the jab, closes in to throw range (780), and throws on
//     the tick the jabber gets free (a throw is active on 3, a new jab on 4). Punishes any move in
//     recovery the same way, or with a jab if there is time; punishes run outside the window (a
//     reaction to the opponent's attack, never seen against an idle or walking opponent). It
//     cancels a jab only if it hit. Window mix-ups inside 780: throw (two cycles in four), sweep
//     or jab; in even cycles a forward jump from 700 to 1100 (a cross-up) with a late air attack,
//     then the jab and its cancel if the air attack combos. Jumps start only in even cycles, so a
//     jump string (up to 81 ticks) ends before the next even window and the odd window passes
//     while it is still going. Gap >= 8.
// Every level KOs an idle opponent; level 1 takes more than 1200 round ticks to do it.

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
  jab: { s: 4, a: 2, r: 7, dmg: 5, reach: 1000, h: "mid", hs: 12, bs: 9, chip: 0 },
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
  if (back) { f.act = "back"; f.x -= f.facing * BACK; return; }
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
  if (a.y > 0 || b.y > 0) return; // v2: only when both are grounded
  let L = a, R = b;
  if (b.x < a.x) { L = b; R = a; }
  else if (b.x === a.x && b.facing === 1 && a.facing === -1) { L = b; R = a; }
  const d = R.x - L.x;
  if (d >= MIN_GAP) return;
  const half = Math.floor((MIN_GAP - d + 1) / 2);
  L.x -= half; R.x += half;
  if (L.x < STAGE_MIN) { R.x += STAGE_MIN - L.x; L.x = STAGE_MIN; }
  if (R.x > STAGE_MAX) { L.x -= R.x - STAGE_MAX; R.x = STAGE_MAX; }
}

type Hit = { def: 0 | 1; m: Move; name: string; blocked: boolean };

function findHit(s: DuelState, i: 0 | 1, defBits: Bits): Hit | null {
  const f = s.f[i], d = s.f[1 - i];
  if (!isMove(f.act) || f.hit) return null;
  const m = MOVES[f.act];
  const isAir = f.act === "air";
  const active = isAir ? f.frame >= m.s : f.frame >= m.s && f.frame < m.s + m.a;
  if (!active) return null;
  const dx = (d.x - f.x) * f.facing;
  if (isAir) { if (dx > m.reach || -dx > m.reach) return null; }
  else if (dx < 0 || dx > m.reach) return null;
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
    if (blocked && isAir) {
      // Cross-ups: hold away from the attacker's position on this tick.
      const away = f.x > d.x ? -1 : f.x < d.x ? 1 : -d.facing;
      if (horiz(defBits) !== away) blocked = false;
    }
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
  const o0 = { ...n.f[0] }, o1 = { ...n.f[1] };
  update(n.f[0], o1, bits[0]);
  update(n.f[1], o0, bits[1]);
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
  const ia = decodeInputs(a.slice(0, MAX_TICKS)), ib = decodeInputs(b.slice(0, MAX_TICKS));
  let s = initDuel();
  while (!s.over && s.tick < MAX_TICKS) {
    const i = s.tick;
    s = step(s, i < ia.length ? ia[i] : 0, i < ib.length ? ib[i] : 0);
  }
  return { winner: s.winner, rounds: [s.f[0].rounds, s.f[1].rounds], ticks: s.tick, hash: stateHash(s) };
}

// Bots: see the header. Index by level.
const BOT_P = [0, 90, 64, 56];
const BOT_W = [0, 12, 8, 12];
const BOT_REACT = [0, 9999, 5, 2];

// A hash of the round, a key (the cycle index) and the side, 0..3.
function mix(s: DuelState, side: number, key: number): number {
  let h = Math.imul(s.round * 7919 + key * 104729 + side * 31337, 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  return h % 4;
}

export function botInput(s: DuelState, side: 0 | 1, level: 1 | 2 | 3): Bits {
  if (s.over || s.pause > 0) return 0;
  const me = s.f[side], op = s.f[1 - side];
  const dir = op.x > me.x ? 1 : op.x < me.x ? -1 : me.facing;
  const toward = dir === 1 ? RIGHT : LEFT, away = dir === 1 ? LEFT : RIGHT;
  const dist = op.x > me.x ? op.x - me.x : me.x - op.x;
  const now = s.roundTick + 1;
  const P = BOT_P[level], cyc = Math.floor(now / P), phase = now % P;
  const open = phase < BOT_W[level];
  const r = mix(s, side, cyc), r2 = mix(s, side + 2, cyc);

  // In the air: only Master attacks, late in its jump so the air attack can combo.
  if (me.act === "jump") return level === 3 && me.vy < 0 && me.y <= 1300 && dist <= 900 ? BA : 0;
  if (me.act === "air") return 0;
  // The jab cancel (levels 2 and 3).
  if (me.act === "jab" && me.hit) {
    if (level === 1 || (level === 3 && op.act !== "hitstun")) return 0; // Master cancels only a jab that hit
    return (r2 & 1) ? BB | DOWN : BB;
  }
  // Keep guarding: crouching against ground moves (it does not retreat), standing against air.
  if (me.act === "blockstun" && me.frame > 1) return away | (op.act === "air" || op.act === "jump" ? 0 : DOWN);

  // Can the bot act on the next step?
  const grounded = me.y === 0 && me.vy <= 0;
  let ready = grounded && isFree(me.act);
  if (grounded && COUNTDOWN.indexOf(me.act) >= 0 && me.frame <= 1) ready = true;
  if (isMove(me.act)) { const m = MOVES[me.act]; if (me.frame + 1 >= m.s + m.a + m.r) ready = true; }
  if (!ready) return 0;

  // Continue a true combo: a jab lands while the opponent has 6+ hitstun ticks left.
  if (level === 3 && me.combo > 0 && op.act === "hitstun" && op.frame >= 6 && dist <= 950) return BA;

  if (level === 1) {
    if (open) {
      if (r === 0 && dist <= 1200) return BB;
      if (dist <= 950) return BA;
      return toward;
    }
    if (phase < 40) return dist < 1000 ? UP | away : 0; // hop back, then wait
    if (phase < P - 30) return 0;
    return dist > 900 ? toward : 0; // walk in for the next window
  }

  // Levels 2 and 3: react to the opponent's move.
  if (isMove(op.act) && op.act !== "throw") {
    const m = MOVES[op.act];
    const end = m.s + m.a + m.r;
    const recovering = op.act !== "air" && op.frame >= m.s + m.a;
    if (recovering) {
      if (open || level === 3) {
        // Punish: a throw lands before the opponent's next jab if it starts as the opponent gets free.
        if (level === 3 && dist <= 780 && op.frame + 1 >= end - 1) return BA | BB;
        if (dist <= 950 && op.frame + 4 < end) return BA;
        if (level === 3 && dist > 780) return toward; // close in for the throw
      }
    } else if (!op.hit && op.frame >= BOT_REACT[level] && dist <= m.reach + 200) {
      return op.act === "air" ? away : away | DOWN; // block on reaction: crouching, standing against air
    }
  }
  if (op.act === "knockdown") return dist > 1000 ? toward : 0; // wait to meet the wake-up
  if (op.act === "jump" || op.act === "air") return 0;
  if (level === 3) {
    if (open) {
      if (r === 3 && (cyc & 1) === 0 && dist >= 700 && dist <= 1100) return UP | toward; // cross-up
      if (dist <= 780) return r === 2 ? DOWN | BB : r === 3 ? BA : BA | BB; // throw, sweep or jab
    }
    return dist > 780 ? toward : 0; // close in to throw range
  }
  if (open) {
    if (op.act === "walk" && dist >= 1100 && dist <= 1250) return BB; // heavy meets the walk-in
    if (dist <= 1000) return BA;
    return toward;
  }
  // Outside the window: keep a spacing, walk in late in the cycle.
  if (dist > 1600 || (phase >= P - 15 && dist > 1000)) return toward;
  return 0;
}
