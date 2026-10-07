"use client";
// /duel, the phone: pick Practice (free, in the browser, against botInput) or Ranked (5 USDC, PvP through the engine;
// a free bot fight if nobody shows up in 10 s), the fight, the result with the replay hash.
// ?mode=practice starts practice at once. ?mock=duel&at=practice|fight|result shows a frozen moment with no engine.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { keccak256, stringToBytes } from "viem";
import { Button, GhostButton, PanelHead, Segmented, TopBar, kit } from "@/components/kit";
import { burner } from "@/lib/engine";
import { CALLSIGN_KEY, cfgFor, loadAvatar, type AvatarCfg } from "@/lib/island/avatar";
import { unitsToUsd, isTxHash } from "@/lib/events";
import { botInput, encodeInputs, initDuel, replay, step, type DuelState } from "./sim";
import { createInput, type InputSource } from "./input";
import { Stage } from "./Stage";
import { Controls } from "./Controls";
import type { View } from "./render";
import { botFight, engineConfigured, leaveQueue, pollTicket, queue } from "./net";
import { DuelLink, winnerSideOf } from "./link";
import { useVerify, type Verify } from "./verify";
import { DUEL_MOMENTS, MOCK_DUEL_ID, MOCK_ME, MOCK_PLAYERS, MOCK_STAKE, mockReplay, mockRun, pickTick, type DuelMoment } from "./mock";
import type { DuelPlayer } from "./types";
import s from "./duel.module.css";

declare global {
  interface Window {
    __duelState?: () => DuelState;
  }
}

const TICK_MS = 1000 / 60;
const STAKE_UNITS = "5000000";
/** "5" for 5000000 units, "5.50" otherwise. */
const usd = (units: string | null | undefined) => unitsToUsd(units ?? STAKE_UNITS).replace(/\.00$/, "");
const LEVELS = [
  { value: "1", label: "Easy" },
  { value: "2", label: "Normal" },
  { value: "3", label: "Hard" },
] as const;
const BOT_ADDR = "0x0000000000000000000000000000000000000b07";

type Me = { address: string | null; avatar: AvatarCfg; callsign: string };
function useMe(): Me {
  const [me, setMe] = useState<Me>({ address: null, avatar: cfgFor("you", "you"), callsign: "" });
  useEffect(() => {
    let address: string | null = null;
    try {
      address = burner().address.toLowerCase();
    } catch {
      /* storage blocked */
    }
    let callsign = "";
    try {
      callsign = localStorage.getItem(CALLSIGN_KEY) ?? "";
    } catch {
      /* ignore */
    }
    setMe({ address, avatar: loadAvatar(address), callsign });
  }, []);
  return me;
}

const toView = (st: DuelState, names: [string, string], bots: [boolean, boolean], avatars: [AvatarCfg, AvatarCfg], me: 0 | 1 | null): View => ({
  f: [
    { ...st.f[0] },
    { ...st.f[1] },
  ],
  round: st.round,
  roundTick: st.roundTick,
  pause: st.pause,
  over: st.over,
  winner: st.winner,
  names,
  bots,
  avatars,
  me,
});

type Screen =
  | { k: "menu" }
  | { k: "practice" }
  | { k: "queue"; ticket: string; since: number }
  | { k: "fight"; duelId: number; side: 0 | 1; token: string | null; ranked: boolean }
  | { k: "mock"; at: DuelMoment };

export default function Duel() {
  const [screen, setScreen] = useState<Screen | null>(null);
  const me = useMe();
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const at = q.get("at") ?? "";
    if (q.get("mock") === "duel") setScreen({ k: "mock", at: (DUEL_MOMENTS as readonly string[]).includes(at) ? (at as DuelMoment) : "fight" });
    else if (q.get("mode") === "practice") setScreen({ k: "practice" });
    else setScreen({ k: "menu" });
  }, []);
  // Back between menu and practice
  const go = useCallback((next: Screen) => {
    setScreen(next);
    try {
      const url = next.k === "practice" ? "/duel?mode=practice" : "/duel";
      if (window.location.pathname + window.location.search !== url && next.k !== "mock") history.pushState(null, "", url);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    const pop = () => setScreen(new URLSearchParams(window.location.search).get("mode") === "practice" ? { k: "practice" } : { k: "menu" });
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);

  if (!screen) return <main className={s.screen} />;
  if (screen.k === "practice") return <Practice me={me} onExit={() => go({ k: "menu" })} />;
  if (screen.k === "mock") return <MockScreen at={screen.at} me={me} />;
  if (screen.k === "queue") return <Queue me={me} ticket={screen.ticket} since={screen.since} onMatched={(t) => setScreen({ k: "fight", duelId: t.duelId, side: t.side, token: t.token, ranked: t.ranked })} onLeft={() => go({ k: "menu" })} />;
  if (screen.k === "fight") return <Ranked me={me} duelId={screen.duelId} side={screen.side} token={screen.token} ranked={screen.ranked} onAgain={() => go({ k: "menu" })} onPractice={() => go({ k: "practice" })} />;
  return <Menu me={me} onPractice={() => go({ k: "practice" })} onQueued={(ticket) => setScreen({ k: "queue", ticket, since: Date.now() })} />;
}

// ---------- menu ----------
function Menu({ me, onPractice, onQueued }: { me: Me; onPractice: () => void; onQueued: (ticket: string) => void }) {
  const [callsign, setCallsign] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setCallsign((c) => c || me.callsign), [me.callsign]);
  const run = useMemo(() => mockRun([3, 2]), []);
  const t0 = useRef(0);
  const avatars: [AvatarCfg, AvatarCfg] = [me.avatar, cfgFor(BOT_ADDR, "dojo bot")];
  const view = (now: number) => {
    if (!t0.current) t0.current = now;
    // the attract loop: a bot match from its first exchange, looping
    const from = 90;
    const i = from + (Math.floor((now - t0.current) / TICK_MS) % (run.states.length - from));
    return toView(run.states[i], ["practice", "dojo bot"], [false, true], avatars, null);
  };
  const valid = callsign.trim().length >= 1 && callsign.trim().length <= 24;
  const ranked = async () => {
    if (!valid || busy) return;
    setErr(null);
    if (!engineConfigured()) return setErr("No engine is configured for this build, so ranked fights are off. Practice works offline.");
    setBusy(true);
    try {
      localStorage.setItem(CALLSIGN_KEY, callsign.trim());
    } catch {
      /* ignore */
    }
    try {
      onQueued(await queue(burner(), callsign.trim()));
    } catch (e) {
      setErr(`Could not join the queue: ${(e as Error).message}`);
      setBusy(false);
    }
  };
  return (
    <main className={s.screen}>
      <TopBar wallet={me.address} />
      <PanelHead color="duel" eyebrow="The Dojo" title="Stickman Duel" />
      <div style={{ height: 210, borderBottom: "var(--stroke) solid var(--ink)" }}>
        <Stage view={view} label="A bot match running in the dojo" />
      </div>
      <div className={s.body}>
        <p className={s.lede}>One on one, best of three rounds. Jab into heavy, sweep the low guard, throw the blocker. Every ranked match is replayed from its inputs before the stake is paid.</p>
        <div className={s.modes}>
          <button type="button" className={s.mode} onClick={onPractice}>
            <b>
              Practice <span className={s.price}>free</span>
            </b>
            <span>Against the dojo bot, right here in your browser. Nothing on chain.</span>
          </button>
        </div>
        <label className={s.field}>
          <span>Your callsign</span>
          <input value={callsign} maxLength={24} onChange={(e) => setCallsign(e.target.value)} placeholder="1 to 24 characters" autoComplete="nickname" />
        </label>
        <Button color="duel" big onClick={ranked} disabled={!valid || busy}>
          {busy ? "Joining the queue…" : "Fight for 5 USDC"}
        </Button>
        {err && <p className={s.err}>{err}</p>}
        <p className={s.fine}>Ranked pairs you with the next player in the queue. Both stakes are taken only once you are matched; the winner gets the pot less the 5% fee. Nobody there after 10 seconds? You can fight the bot for free instead.</p>
      </div>
    </main>
  );
}

// ---------- practice ----------
function Practice({ me, onExit }: { me: Me; onExit: () => void }) {
  const [level, setLevel] = useState<"1" | "2" | "3">("2");
  const [done, setDone] = useState<{ winner: 0 | 1 | null; rounds: [number, number]; hash: string } | null>(null);
  const [game, setGame] = useState(0);
  const input = useMemo<InputSource | null>(() => (typeof window === "undefined" ? null : createInput()), []);
  useEffect(() => () => input?.dispose(), [input]);
  const sim = useRef({ st: initDuel(), prev: initDuel(), acc: 0, last: 0, ins: [[], []] as [number[], number[]] });
  const levelRef = useRef(level);
  levelRef.current = level;
  useEffect(() => {
    sim.current = { st: initDuel(), prev: initDuel(), acc: 0, last: 0, ins: [[], []] };
    setDone(null);
    window.__duelState = () => sim.current.st;
    return () => {
      delete window.__duelState;
    };
  }, [game]);
  const name = me.callsign || me.avatar.name || "you";
  const avatars: [AvatarCfg, AvatarCfg] = [me.avatar, cfgFor(BOT_ADDR + level, "dojo bot")];
  const view = (now: number): View => {
    const g = sim.current;
    if (!g.last) g.last = now;
    g.acc = Math.min(g.acc + (now - g.last), TICK_MS * 6);
    g.last = now;
    while (g.acc >= TICK_MS) {
      g.acc -= TICK_MS;
      if (g.st.over) break;
      const a = input?.bits() ?? 0;
      const b = botInput(g.st, 1, Number(levelRef.current) as 1 | 2 | 3);
      g.ins[0].push(a);
      g.ins[1].push(b);
      g.prev = g.st;
      g.st = step(g.st, a, b);
      if (g.st.over) {
        const r = replay(encodeInputs(g.ins[0]), encodeInputs(g.ins[1]));
        const fin = g.st;
        setTimeout(() => setDone({ winner: fin.winner, rounds: [fin.f[0].rounds, fin.f[1].rounds], hash: r.hash }), 1200);
      }
    }
    // draw between the last two ticks
    const t = g.acc / TICK_MS;
    const v = toView(g.st, [name, "dojo bot"], [false, true], avatars, 0);
    for (const i of [0, 1] as const) {
      const p = g.prev.f[i],
        c = g.st.f[i];
      if (Math.abs(c.x - p.x) < 1500 && p.act !== undefined && g.prev.round === g.st.round) {
        v.f[i].x = p.x + (c.x - p.x) * t;
        v.f[i].y = p.y + (c.y - p.y) * t;
      }
    }
    return v;
  };
  return (
    <main className={s.fight}>
      <TopBar wallet={me.address}>
        <span className={kit.chip}>Practice</span>
      </TopBar>
      <div className={s.levelRow}>
        <span>Bot</span>
        <div>
          <Segmented label="Bot level" options={LEVELS} value={level} onChange={(v) => setLevel(v as "1" | "2" | "3")} />
        </div>
      </div>
      <div className={s.stageBox}>
        <Stage key={game} view={view} label="Practice fight against the dojo bot" />
        {done && (
          <div className={s.overlay}>
            <div className={kit.panel} style={{ padding: 14, display: "grid", gap: 10 }}>
              <p className={s.verdict} style={{ fontSize: 24 }}>
                {done.winner === 0 ? "You beat the bot" : done.winner === 1 ? "The bot wins" : "A draw"}{" "}
                <span className={s.score}>
                  {done.rounds[0]}–{done.rounds[1]}
                </span>
              </p>
              <p className={s.fine}>
                Replay hash <span className={s.fig}>{done.hash}</span>. Practice is free: nothing was staked or paid.
              </p>
              <div className={s.two}>
                <Button color="duel" onClick={() => setGame((x) => x + 1)}>
                  Fight again
                </Button>
                <GhostButton onClick={onExit}>Back to the dojo</GhostButton>
              </div>
            </div>
          </div>
        )}
      </div>
      {input && <Controls input={input} />}
      <p className={`${s.fine} ${s.keys}`} style={{ padding: "0 18px 12px", textAlign: "center" }}>
        Keyboard: arrows move, jump and crouch; hold back to block; Z is A, X is B, Z and X together throw.
      </p>
    </main>
  );
}

// ---------- queue ----------
type Matched = { duelId: number; side: 0 | 1; token: string | null; ranked: boolean };
function Queue({ me, ticket, since, onMatched, onLeft }: { me: Me; ticket: string; since: number; onMatched: (m: Matched) => void; onLeft: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      setNow(Date.now());
      try {
        const t = await pollTicket(ticket);
        if (stop) return;
        if (t.status === "matched" && t.duelId !== null && t.side !== null) return onMatched({ duelId: t.duelId, side: t.side, token: t.sessionToken, ranked: t.ranked });
        setErr(null);
      } catch (e) {
        if (!stop) setErr(`Lost the queue: ${(e as Error).message}`);
      }
      if (!stop) setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [ticket, onMatched]);
  const waited = Math.floor((now - since) / 1000);
  // back to the menu only once the engine let go of the ticket (200) or never knew it (404); matched meanwhile: fight
  const leave = async () => {
    setBusy(true);
    try {
      const r = await leaveQueue(ticket);
      if (r.status === 200 || r.status === 404) return onLeft();
      if (r.status === 409 && r.ticket && r.ticket.duelId !== null && r.ticket.side !== null) return onMatched({ duelId: r.ticket.duelId, side: r.ticket.side, token: r.ticket.sessionToken, ranked: r.ticket.ranked });
      setErr(`Could not leave the queue (the engine answered ${r.status}).`);
    } catch (e) {
      setErr(`Could not leave the queue: ${(e as Error).message}`);
    }
    setBusy(false);
  };
  const fightBot = async () => {
    setBusy(true);
    try {
      const t = await botFight(ticket);
      if (t.duelId !== null && t.side !== null) onMatched({ duelId: t.duelId, side: t.side, token: t.sessionToken, ranked: false });
      else setBusy(false);
    } catch (e) {
      setErr(`The bot fight did not start: ${(e as Error).message}`);
      setBusy(false);
    }
  };
  return (
    <main className={s.screen}>
      <TopBar wallet={me.address}>
        <span className={kit.chip}>Ranked</span>
      </TopBar>
      <PanelHead color="duel" eyebrow="The Dojo · queue" title="Looking for an opponent" />
      <div className={s.body}>
        <div className={s.waiting}>
          <span className={s.clock}>{String(Math.floor(waited / 60)).padStart(2, "0")}:{String(waited % 60).padStart(2, "0")}</span>
          <p className={s.lede}>You are next in line. The fight starts as soon as another player queues. Nothing is staked until you are matched.</p>
        </div>
        {waited >= 10 ? (
          <>
            <Button color="duel" big onClick={fightBot} disabled={busy}>
              {busy ? "Calling the bot…" : "Fight the bot for free"}
            </Button>
            <p className={s.fine}>The bot fight has no stake and pays nothing. Or keep waiting here for a player.</p>
          </>
        ) : (
          <p className={s.fine}>No one yet? In {10 - waited} s you can fight the bot for free instead.</p>
        )}
        {err && <p className={s.err}>{err}</p>}
        <GhostButton onClick={leave} disabled={busy}>
          Leave the queue
        </GhostButton>
      </div>
    </main>
  );
}

// ---------- ranked fight and result ----------
function useLink(duelId: number, side: 0 | 1 | null, token: string | null) {
  const link = useMemo(() => (typeof window === "undefined" ? null : new DuelLink(duelId, side, token)), [duelId, side, token]);
  useEffect(() => () => link?.close(), [link]);
  const info = useSyncExternalStore(
    (f) => link?.subscribe(f) ?? (() => {}),
    () => link?.info ?? null,
    () => null,
  );
  return { link, info };
}

function Ranked({ me, duelId, side, token, ranked, onAgain, onPractice }: { me: Me; duelId: number; side: 0 | 1; token: string | null; ranked: boolean; onAgain: () => void; onPractice: () => void }) {
  const { link, info } = useLink(duelId, side, token);
  const input = useMemo<InputSource | null>(() => (typeof window === "undefined" ? null : createInput()), []);
  useEffect(() => () => input?.dispose(), [input]);
  const verify = useVerify(duelId, info?.final ?? null, info?.players ?? []);
  const [showResult, setShowResult] = useState(false);
  useEffect(() => {
    if (!info?.final) return;
    const id = setTimeout(() => setShowResult(true), 2500);
    return () => clearTimeout(id);
  }, [info?.final]);
  const players = info?.players ?? [];
  const nameOf = (i: 0 | 1) => players[i]?.callsign || (i === side ? me.callsign || "you" : "opponent");
  const avatarOf = (i: 0 | 1) => (i === side ? me.avatar : cfgFor(players[i]?.player ?? `p${i}`, nameOf(i)));
  const lastView = useRef<View | null>(null);
  const view = (now: number): View | null => {
    link?.input(input?.bits() ?? 0);
    const fr = link?.frame(now);
    if (!fr) return null;
    return (lastView.current = { ...fr, names: [nameOf(0), nameOf(1)], bots: [!!players[0]?.bot, !!players[1]?.bot], avatars: [avatarOf(0), avatarOf(1)], me: side });
  };
  // the result waits until the winner can be placed (players known or winnerSide given)
  if (showResult && info?.final && winnerSideOf(info.final, players) !== undefined)
    return <Result me={me} side={side} players={players} final={info.final} settled={info.settled} verify={verify} ranked={info.ranked ?? ranked} stakeUnits={info.stakeUnits} duelId={duelId} last={lastView.current} onAgain={onAgain} onPractice={onPractice} />;
  const status = info?.missing ? "No such duel on this engine" : info?.cancelled ? `Cancelled: ${info.cancelled}` : info?.final ? "Replaying the match" : !info?.connected ? "Connecting…" : info.status === "countdown" || info.status === "matching" ? "Get ready" : info.status === "settling" ? "Replaying the match" : "Live";
  return (
    <main className={s.fight}>
      <TopBar wallet={me.address}>
        <span className={kit.chip}>{ranked ? "Ranked" : "Bot fight"}</span>
      </TopBar>
      <div className={s.strip}>
        <span>
          Duel <span className={s.fig}>#{duelId}</span> · {ranked ? <>stake <span className={s.fig}>{usd(info?.stakeUnits)}</span> USDC</> : "free, no stake"}
        </span>
        <span>{status}</span>
      </div>
      <div className={s.stageBox}>
        <Stage view={view} label={`Duel ${duelId}`} />
      </div>
      {input && <Controls input={input} />}
    </main>
  );
}

function Result({ me, side, players, final, settled, verify, ranked, stakeUnits, duelId, last, onAgain, onPractice }: {
  me: Me;
  side: 0 | 1;
  players: DuelPlayer[];
  final: { winner: string | null; winnerSide?: 0 | 1 | null; bookHash: string; rounds: [number, number]; payoutUnits: string };
  stakeUnits: string | null;
  settled: { txHash: string } | null;
  verify: Verify;
  ranked: boolean;
  duelId: number;
  /** The last frame of the fight, drawn above the result. */
  last: View | null;
  onAgain: () => void;
  onPractice: () => void;
}) {
  const ws = winnerSideOf(final, players);
  const won = ws === side;
  const draw = ws === null;
  const offline = !!settled && !isTxHash(settled.txHash);
  const verdict = draw ? "A draw" : won ? "You win" : "You lose";
  const opp = players[1 - side]?.callsign ?? "your opponent";
  return (
    <main className={s.screen}>
      <TopBar wallet={me.address}>
        <span className={kit.chip}>{ranked ? "Ranked" : "Bot fight"}</span>
      </TopBar>
      <PanelHead color="duel" eyebrow={`Duel #${duelId} · result`} title={verdict} />
      {last && (
        <div style={{ height: 190, borderBottom: "var(--stroke) solid var(--ink)" }}>
          <Stage view={() => last} hud={false} label="The last frame of the fight" />
        </div>
      )}
      <div className={s.body}>
        <p className={s.lede}>
          <span className={s.score}>
            {final.rounds[side]}–{final.rounds[1 - side]}
          </span>{" "}
          against {opp}
          {players[1 - side]?.bot ? " (bot)" : ""}.
        </p>
        {ranked && (
          <div className={s.rows}>
            <div>
              {won ? "Your payout" : draw ? "Your stake" : "Payout to the winner"}
              <b>
                {draw ? <>{usd(stakeUnits)} USDC back</> : <span className={won && !offline ? s.chipSun : undefined}>{unitsToUsd(final.payoutUnits)} USDC</span>}
                {!settled ? <span className={s.prov}>provisional</span> : offline ? <span className={s.prov}>not paid, offline</span> : null}
              </b>
            </div>
            <div>
              Settlement
              <b>{!settled ? "Waiting for the replay report" : offline ? "Settled offline (no chain), nothing paid" : `${draw ? "Refunded" : "Paid"}, tx ${settled.txHash.slice(0, 10)}…`}</b>
            </div>
          </div>
        )}
        {!ranked && <p className={s.fine}>A free fight against the bot: no stake, no payout.</p>}
        <div className={s.rows}>
          <div>
            Replay hash<b>{verify ? verify.hash : "replaying…"}</b>
          </div>
          <div>
            Replayed here<b>{verify ? (verify.matches ? `same winner, ${verify.ticks} ticks` : "does not match the engine") : "–"}</b>
          </div>
          <div>
            Book hash<b title={final.bookHash}>{final.bookHash.slice(0, 10)}…{final.bookHash.slice(-6)}{verify ? (verify.bookHashOk ? " ✓" : " (differs)") : ""}</b>
          </div>
        </div>
        <div className={s.two}>
          <Button color="duel" onClick={onAgain}>
            Fight again
          </Button>
          <GhostButton onClick={onPractice}>Practice</GhostButton>
        </div>
        <GhostButton href="/">Back to the island</GhostButton>
      </div>
    </main>
  );
}

// ---------- mock moments ----------
// The [3, 2] bot match: in practice you are fighter 0 against the bot; in the ranked moments you are kestrel, side 1,
// who wins it 2-0.
function MockScreen({ at, me }: { at: DuelMoment; me: Me }) {
  const run = useMemo(() => mockRun([3, 2]), []);
  const tick = useMemo(() => pickTick(run, at === "practice" ? 200 : 620), [run, at]);
  const rep = useMemo(() => mockReplay(run), [run]);
  const input = useMemo<InputSource | null>(() => (typeof window === "undefined" ? null : createInput()), []);
  useEffect(() => () => input?.dispose(), [input]);
  const youName = me.callsign || MOCK_PLAYERS[MOCK_ME].callsign;
  const players: [DuelPlayer, DuelPlayer] = [MOCK_PLAYERS[0], { ...MOCK_PLAYERS[1], callsign: youName }];
  const oppAvatar = cfgFor(MOCK_PLAYERS[0].player, MOCK_PLAYERS[0].callsign);
  if (at === "result") {
    const fin = run.final;
    const book = JSON.stringify({ mode: "duel", duelId: MOCK_DUEL_ID, players: MOCK_PLAYERS.map((p) => p.player), stakeUnits: MOCK_STAKE, feeBps: 500, inputs: rep.inputs, ticks: rep.ticks, logHash: "0x" + "0".repeat(64) });
    const winner = fin.winner === null ? null : MOCK_PLAYERS[fin.winner].player;
    return (
      <Result
        me={me}
        side={MOCK_ME}
        players={players}
        final={{ winner, winnerSide: fin.winner, bookHash: keccak256(stringToBytes(book)), rounds: [fin.f[0].rounds, fin.f[1].rounds], payoutUnits: "9500000" }}
        stakeUnits={MOCK_STAKE}
        settled={null}
        verify={{ hash: rep.hash, ticks: rep.ticks, matches: true, bookHashOk: true }}
        ranked
        duelId={MOCK_DUEL_ID}
        last={toView(fin, [players[0].callsign, youName], [false, false], [oppAvatar, me.avatar], MOCK_ME)}
        onAgain={() => {}}
        onPractice={() => {}}
      />
    );
  }
  const st = run.states[tick];
  const practice = at === "practice";
  const view = practice
    ? () => toView(st, [youName, "dojo bot"], [false, true], [me.avatar, cfgFor(BOT_ADDR + "3", "dojo bot")], 0)
    : () => toView(st, [players[0].callsign, youName], [false, false], [oppAvatar, me.avatar], MOCK_ME);
  return (
    <main className={s.fight}>
      <TopBar wallet={me.address}>
        <span className={kit.chip}>{practice ? "Practice" : "Ranked"}</span>
      </TopBar>
      {practice ? (
        <div className={s.levelRow}>
          <span>Bot</span>
          <div>
            <Segmented label="Bot level" options={LEVELS} value="3" onChange={() => {}} />
          </div>
        </div>
      ) : (
        <div className={s.strip}>
          <span>
            Duel <span className={s.fig}>#{MOCK_DUEL_ID}</span> · stake <span className={s.fig}>{usd(MOCK_STAKE)}</span> USDC
          </span>
          <span>Live · mock data</span>
        </div>
      )}
      <div className={s.stageBox}>
        <Stage view={view} label="Mock duel" />
      </div>
      {input && <Controls input={input} />}
    </main>
  );
}
