"use client";
// /duel, the phone: pick Practice (free, in the browser, against botInput) or Ranked (5 USDC, PvP through the engine;
// a free bot fight if nobody shows up in 10 s), the fight, the result with the replay hash.
// ?mode=practice starts practice at once. ?mock=duel&at=practice|fight|result shows a frozen moment with no engine.
// Every screen has the app bar (back to its parent, CLAUDE.md "Navigation" > "Hierarchy"); queue and fight are in the
// URL (see "the URL holds the screen" below).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { keccak256, stringToBytes } from "viem";
import { Button, GhostButton, PanelHead, Segmented, TopBar, kit, type Back } from "@/components/kit";
import { EndActions, type Action } from "@/components/kit/actions";
import Link from "@/components/kit/link";
import { AvatarHead } from "@/components/play/Avatar";
import { PANEL, docTitle, duel as duelRoute, island, watchDuel } from "@/lib/nav";
import { useUrlState } from "@/lib/useUrlState";
import { useDocTitle } from "@/components/arena/title";
import { engineHttp } from "@/lib/engineUrl";
import { burner } from "@/lib/engine";
import { CALLSIGN_KEY, cfgFor, loadAvatar, type AvatarCfg } from "@/lib/island/avatar";
import { unitsToUsd, isTxHash } from "@/lib/events";
import { botInput, encodeInputs, initDuel, replay, step, type DuelState } from "./sim";
import { createInput, type InputSource } from "./input";
import { Stage } from "./Stage";
import { Controls } from "./Controls";
import type { View } from "./render";
import { botFight, engineConfigured, leaveQueue, queue, ticketStatus } from "./net";
import { DuelLink, winnerSideOf } from "./link";
import { useVerify, type Verify } from "./verify";
import { DUEL_MOMENTS, MOCK_DUEL_ID, MOCK_ME, MOCK_PLAYERS, MOCK_STAKE, mockReplay, mockRun, pickTick, type DuelMoment } from "./mock";
import { parseDuels, type DuelPlayer, type DuelsLive, type QueueTicket } from "./types";
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
    // Your saved look, else the look everyone else derives from your address (so you match the arena and your opponent).
    let saved = false;
    try {
      saved = !!address && localStorage.getItem(`royale.avatar.${address.toLowerCase()}`) !== null;
    } catch {
      /* storage blocked */
    }
    setMe({ address, avatar: saved || !address ? loadAvatar(address) : cfgFor(address, callsign.trim() || "Player"), callsign });
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

// ---------- the URL holds the screen (CLAUDE.md "Navigation" rule 7) ----------
// /duel (menu), ?mode=practice, ?ticket=<t> (queued), ?duel=<id> (fighting, then the result), ?mock=duel&at=<moment>.
// The ticket and the matched duel's side and session token live in sessionStorage, so a refresh gets back in: a queued
// ticket the engine still holds is polled again (one it dropped, because pagehide left the queue, is queued afresh with
// the same callsign), and a fight takes its session token back from GET /duels/queue/:ticket.
const SESSION = "royale.duel.session";
type Session = { ticket: string; since: number; callsign: string; duelId?: number; side?: 0 | 1; token?: string | null; ranked?: boolean; after?: number };
const readSession = (): Session | null => {
  try {
    const v = JSON.parse(sessionStorage.getItem(SESSION) ?? "null") as Session | null;
    return v && typeof v.ticket === "string" ? v : null;
  } catch {
    return null;
  }
};
const writeSession = (v: Session | null) => {
  try {
    if (v) sessionStorage.setItem(SESSION, JSON.stringify(v));
    else sessionStorage.removeItem(SESSION);
  } catch {
    /* storage blocked */
  }
};
const posInt = (v: string | null) => {
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 ? n : null;
};
type Url = ReturnType<typeof useUrlState>;

/** Queue again with the stored callsign ("Fight again", N34). `after`: the duel just fought, which the engine keeps
 *  answering with until it is settled. Without a callsign or an engine: the menu. */
async function requeue(url: Url, after?: number) {
  let callsign = "";
  try {
    callsign = (localStorage.getItem(CALLSIGN_KEY) ?? "").trim();
  } catch {
    /* ignore */
  }
  if (!callsign || !engineConfigured()) return url.replace({ duel: null, ticket: null });
  try {
    const ticket = await queue(burner(), callsign);
    writeSession({ ticket, since: Date.now(), callsign, after });
    url.replace({ duel: null, ticket });
  } catch {
    url.replace({ duel: null, ticket: null });
  }
}

/** Escape goes to the parent (rule 4), unless something on the page already used it (a menu). */
function useEscape(go: (() => void) | null) {
  const ref = useRef(go);
  ref.current = go;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !ref.current) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      ref.current();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
}

const useTitle = (screen?: string) => useDocTitle(docTitle("duel", screen));

/** The app bar for every /duel screen: back control, brand, switcher (Stickman Duel current), you chip. */
function Bar({ me, back, watch, children }: { me: Me; back?: Back; watch?: string | null; children?: ReactNode }) {
  return (
    <TopBar back={back} game="duel" watch={watch ?? null} wallet={me.address} callsign={me.callsign || null} avatar={me.address ? <AvatarHead cfg={me.avatar} size={28} /> : undefined} className={s.top}>
      {children}
    </TopBar>
  );
}

export default function Duel() {
  const me = useMe();
  const url = useUrlState();
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) return <main className={s.screen} />;
  const q = url.params;
  if (q.get("mock") === "duel") {
    const at = q.get("at") ?? "";
    return <MockScreen at={(DUEL_MOMENTS as readonly string[]).includes(at) ? (at as DuelMoment) : "fight"} me={me} />;
  }
  if (q.get("mode") === "practice") return <Practice me={me} url={url} />;
  const ticket = q.get("ticket");
  if (ticket) return <Queue key={ticket} me={me} url={url} ticket={ticket} />;
  const duelId = posInt(q.get("duel"));
  if (duelId) return <FightRoute key={duelId} me={me} url={url} duelId={duelId} />;
  return <Menu me={me} url={url} />;
}

// ---------- menu ----------
function useLiveDuels(): DuelsLive[] | null {
  const [live, setLive] = useState<DuelsLive[] | null>(null);
  useEffect(() => {
    if (!engineConfigured()) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stop) return;
      if (!document.hidden) {
        try {
          const r = await fetch(`${engineHttp()}/duels`, { cache: "no-store" });
          if (!stop) setLive(r.ok ? parseDuels(await r.json()).live : []);
        } catch {
          /* keep the last list */
        }
      }
      if (!stop) t = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, []);
  return live;
}

function Menu({ me, url }: { me: Me; url: Url }) {
  const [callsign, setCallsign] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  useTitle();
  useEscape(() => router.push(island(PANEL.duel)));
  useEffect(() => setCallsign((c) => c || me.callsign), [me.callsign]);
  const live = useLiveDuels();
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
      const ticket = await queue(burner(), callsign.trim());
      writeSession({ ticket, since: Date.now(), callsign: callsign.trim() });
      url.push({ ticket });
    } catch (e) {
      setErr(`Could not join the queue: ${(e as Error).message}`);
      setBusy(false);
    }
  };
  return (
    <main className={s.screen}>
      <Bar me={me} back={{ to: "the island", href: island(PANEL.duel) }} />
      <PanelHead color="duel" eyebrow="The Dojo" title="Stickman Duel" />
      <div style={{ height: 210, borderBottom: "var(--stroke) solid var(--ink)" }}>
        <Stage view={view} label="A bot match running in the dojo" />
      </div>
      <div className={s.body}>
        <p className={s.lede}>One on one, best of three rounds. Jab into heavy, sweep the low guard, throw the blocker. Every ranked match is replayed from its inputs before the stake is paid.</p>
        <div className={s.modes}>
          <button type="button" className={s.mode} onClick={() => url.push({ mode: "practice" })} aria-label="Practice for free against the dojo bot">
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
        {live !== null && (
          <section className={s.live} aria-label="Live duels">
            <h2>Live now</h2>
            {live.length ? (
              <ul>
                {live.map((d) => (
                  <li key={d.duelId}>
                    <span>
                      <b>{d.players.map((p) => `${p.callsign || p.player.slice(0, 6)}${p.bot ? " (bot)" : ""}`).join(" vs ") || `Duel #${d.duelId}`}</b>
                      <small>
                        Duel #{d.duelId} · round {d.round} · {d.hp[0]}–{d.hp[1]} hp
                      </small>
                    </span>
                    <Link href={watchDuel(d.duelId)} className={kit.chip} aria-label={`Watch duel ${d.duelId} on the big screen`}>
                      Watch
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={s.fine}>No duel is running right now. Queue up and the next one is yours.</p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

// ---------- practice ----------
/** Practice / Ranked, as two links (never takes focus or arrow keys: the fight's keyboard stays free). */
function ModeSwitch({ current }: { current: "practice" | "ranked" }) {
  return (
    <nav className={`${kit.seg} ${s.modeSwitch}`} aria-label="Practice or ranked">
      <Link href={duelRoute("practice")} replace aria-current={current === "practice" ? "page" : undefined}>
        Practice
      </Link>
      <Link href={duelRoute()} replace aria-current={current === "ranked" ? "page" : undefined}>
        Ranked
      </Link>
    </nav>
  );
}

function Practice({ me, url }: { me: Me; url: Url }) {
  const [level, setLevel] = useState<"1" | "2" | "3">("2");
  const [done, setDone] = useState<{ winner: 0 | 1 | null; rounds: [number, number]; hash: string } | null>(null);
  const [game, setGame] = useState(0);
  const toMenu = () => url.back({ mode: null });
  useTitle("Practice");
  useEscape(toMenu);
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
  const name = me.callsign || (me.avatar.name !== "you" ? me.avatar.name : "") || "Player";
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
      <Bar me={me} back={{ to: "the Dojo", onClick: toMenu }} />
      <div className={s.levelRow}>
        <ModeSwitch current="practice" />
        <div>
          <Segmented label="Bot level" options={LEVELS} value={level} onChange={(v) => setLevel(v as "1" | "2" | "3")} />
        </div>
      </div>
      <div className={s.stageBox}>
        <Stage key={game} view={view} label="Practice fight against the dojo bot" />
        {done && (
          <div className={`${s.overlay} ${s.endBox}`}>
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
              <EndActions game="duel" primary={{ label: "Fight again", onClick: () => setGame((x) => x + 1) }} more={[{ label: "Fight for 5 USDC", href: duelRoute(), replace: true }]} />
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
function Queue({ me, url, ticket }: { me: Me; url: Url; ticket: string }) {
  const session = useMemo(() => {
    const v = readSession();
    return v?.ticket === ticket ? v : null;
  }, [ticket]);
  const since = session?.since ?? Date.now();
  const [now, setNow] = useState(Date.now());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settling, setSettling] = useState<number | null>(null);
  // still holding a waiting ticket on the engine: leaving the page (any way) leaves the queue
  const holding = useRef(true);
  useTitle("Queue");
  const matched = useCallback(
    (t: QueueTicket) => {
      if (t.duelId === null || t.side === null) return;
      holding.current = false;
      writeSession({ ticket, since, callsign: session?.callsign ?? me.callsign, duelId: t.duelId, side: t.side, token: t.sessionToken, ranked: t.ranked });
      url.replace({ ticket: null, duel: t.duelId });
    },
    [ticket, since, session, me.callsign, url],
  );
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      setNow(Date.now());
      try {
        const r = await ticketStatus(ticket);
        if (stop) return;
        if (r.status === 404) {
          // the engine let go of the ticket (pagehide left the queue before a refresh, or it restarted): queue again
          holding.current = false;
          const callsign = session?.callsign || me.callsign;
          if (!callsign) return url.replace({ ticket: null });
          const fresh = await queue(burner(), callsign);
          writeSession({ ticket: fresh, since, callsign, after: session?.after });
          return url.replace({ ticket: fresh });
        }
        const t = r.ticket;
        if (t?.status === "matched") {
          // "Fight again" right after a duel: the engine answers with that duel's ticket until it is settled
          if (session?.after !== undefined && t.duelId === session.after) {
            holding.current = false;
            setSettling(t.duelId);
            if (!stop) setTimeout(() => void requeue(url, session.after), 2000);
            return;
          }
          return matched(t);
        }
        setErr(r.status === 200 ? null : `The engine answered ${r.status}.`);
      } catch (e) {
        if (!stop) setErr(`Lost the queue: ${(e as Error).message}`);
      }
      if (!stop) setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket]);
  // rule 9: leaving while queued leaves the queue (keepalive survives the page going away)
  useEffect(() => {
    const hide = () => {
      if (holding.current) void leaveQueue(ticket, true).catch(() => {});
    };
    addEventListener("pagehide", hide);
    return () => {
      removeEventListener("pagehide", hide);
      if (holding.current) {
        holding.current = false;
        writeSession(null);
        void leaveQueue(ticket, true).catch(() => {});
      }
    };
  }, [ticket]);
  const waited = Math.max(0, Math.floor((now - since) / 1000));
  // back to the menu only once the engine let go of the ticket (200) or never knew it (404); matched meanwhile: fight
  const leave = async () => {
    setBusy(true);
    try {
      const r = await leaveQueue(ticket);
      if (r.status === 200 || r.status === 404) {
        holding.current = false;
        writeSession(null);
        return url.back({ ticket: null });
      }
      if (r.status === 409 && r.ticket && r.ticket.duelId !== null && r.ticket.side !== null) return matched(r.ticket);
      // 409 while waiting: already paired, the duel is being set up; the poll takes you to the fight
      if (r.status === 409) return setErr("You were just paired with a player: the duel is being set up, so the queue can no longer be left.");
      setErr(`Could not leave the queue (the engine answered ${r.status}).`);
    } catch (e) {
      setErr(`Could not leave the queue: ${(e as Error).message}`);
    }
    setBusy(false);
  };
  useEscape(() => void leave());
  const fightBot = async () => {
    setBusy(true);
    try {
      const t = await botFight(ticket);
      if (t.duelId !== null && t.side !== null) matched({ ...t, ranked: false });
      else setBusy(false);
    } catch (e) {
      setErr(`The bot fight did not start: ${(e as Error).message}`);
      setBusy(false);
    }
  };
  return (
    <main className={s.screen}>
      <Bar me={me} back={{ to: "the Dojo, leaving the queue", onClick: () => void leave() }} />
      <PanelHead color="duel" eyebrow="The Dojo · ranked queue" title={settling ? "Finishing your last duel" : "Looking for an opponent"} />
      <div className={s.body}>
        <div className={s.waiting}>
          <span className={s.clock}>{String(Math.floor(waited / 60)).padStart(2, "0")}:{String(waited % 60).padStart(2, "0")}</span>
          <p className={s.lede}>{settling ? `Duel #${settling} is still settling. You join the queue as soon as it is done.` : "You are next in line. The fight starts as soon as another player queues. Nothing is staked until you are matched."}</p>
        </div>
        {settling ? null : waited >= 10 ? (
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

/** /duel?duel=<id>: your side and session token from sessionStorage, the token refreshed from the ticket. */
function FightRoute({ me, url, duelId }: { me: Me; url: Url; duelId: number }) {
  const [sess, setSess] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    const v = readSession();
    const mine = v && v.duelId === duelId && (v.side === 0 || v.side === 1) ? v : null;
    setSess(mine);
    if (!mine || !engineConfigured()) return;
    let stop = false;
    ticketStatus(mine.ticket)
      .then((r) => {
        if (stop || !r.ticket || r.ticket.duelId !== duelId || !r.ticket.sessionToken || r.ticket.sessionToken === mine.token) return;
        const next = { ...mine, token: r.ticket.sessionToken };
        writeSession(next);
        setSess(next);
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [duelId]);
  useTitle(`Duel #${duelId}`);
  if (sess === undefined) return <main className={s.screen} />;
  if (!sess)
    return (
      <main className={s.screen}>
        <Bar me={me} back={{ to: "the Dojo", onClick: () => url.back({ duel: null }) }} watch={watchDuel(duelId)} />
        <PanelHead color="duel" eyebrow={`Duel #${duelId}`} title="Not your fight" />
        <div className={s.body}>
          <p className={s.lede}>This browser did not queue for duel #{duelId}, so it cannot play a side in it. You can still watch it.</p>
          <EndActions game="duel" primary={{ label: "Watch it on the big screen", href: watchDuel(duelId) }} more={[{ label: "Back to the Dojo", onClick: () => url.back({ duel: null }) }]} />
        </div>
      </main>
    );
  return <Ranked me={me} url={url} duelId={duelId} side={sess.side as 0 | 1} token={sess.token ?? null} ranked={sess.ranked ?? true} />;
}

function Ranked({ me, url, duelId, side, token, ranked }: { me: Me; url: Url; duelId: number; side: 0 | 1; token: string | null; ranked: boolean }) {
  const { link, info } = useLink(duelId, side, token);
  const input = useMemo<InputSource | null>(() => (typeof window === "undefined" ? null : createInput()), []);
  useEffect(() => () => input?.dispose(), [input]);
  const verify = useVerify(duelId, info?.final ?? null, info?.players ?? []);
  const [showResult, setShowResult] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!info?.final) return;
    const id = setTimeout(() => setShowResult(true), 2500);
    return () => clearTimeout(id);
  }, [info?.final]);
  // never connects: after 10 s offer a way on instead of "Connecting…" forever
  const connected = !!info?.connected;
  useEffect(() => {
    if (connected) return setSlow(false);
    const id = setTimeout(() => setSlow(true), 10000);
    return () => clearTimeout(id);
  }, [connected]);
  const isRanked = info?.ranked ?? ranked;
  const blocked = info?.missing ? "missing" : info?.cancelled ? "cancelled" : !connected && slow && !info?.final ? "offline" : null;
  // a live ranked fight: leaving asks first (rule 9); it can be re-entered from /duel?duel=<id>
  const live = isRanked && !blocked && !info?.final && (info?.status === "live" || info?.status === "countdown" || info?.status === "matching");
  const liveRef = useRef(live);
  liveRef.current = live;
  const ASK = "Leave this ranked fight? Your fighter stands still while you are away. You can come back to it from this page.";
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (!liveRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    // in-app links do not unload the page: ask on the click instead
    const click = (e: MouseEvent) => {
      if (!liveRef.current || e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a || !confirm(ASK)) {
        if (a) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    };
    addEventListener("beforeunload", before);
    addEventListener("click", click, true);
    return () => {
      removeEventListener("beforeunload", before);
      removeEventListener("click", click, true);
    };
  }, []);
  const toMenu = () => {
    if (liveRef.current && !confirm(ASK)) return;
    writeSession(null);
    url.back({ duel: null });
  };
  const again = () => void requeue(url, duelId);
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
    return (
      <Result
        me={me}
        side={side}
        players={players}
        final={info.final}
        settled={info.settled}
        verify={verify}
        ranked={isRanked}
        stakeUnits={info.stakeUnits}
        duelId={duelId}
        last={lastView.current}
        back={{ to: "the Dojo", onClick: toMenu }}
        again={{ label: "Fight again", onClick: again }}
        watch={watchDuel(duelId)}
        onEscape={toMenu}
      />
    );
  const status = info?.final ? "Replaying the match" : !info?.connected ? "Connecting…" : info.status === "countdown" || info.status === "matching" ? "Get ready" : info.status === "settling" ? "Replaying the match" : "Live";
  return (
    <main className={blocked ? s.screen : s.fight}>
      <Bar me={me} back={{ to: "the Dojo", onClick: toMenu }} watch={watchDuel(duelId)} />
      {blocked ? (
        <>
          <PanelHead color="duel" eyebrow={`Duel #${duelId}`} title={blocked === "missing" ? "No such duel" : blocked === "cancelled" ? "Duel cancelled" : "Not connected"} />
          <div className={s.body}>
            <p className={s.lede}>
              {blocked === "missing"
                ? `This engine has no duel #${duelId}. It may have restarted.`
                : blocked === "cancelled"
                  ? `${info?.cancelled && info.cancelled !== "cancelled" ? `${info.cancelled.charAt(0).toUpperCase()}${info.cancelled.slice(1).replace(/[.\s]+$/, "")}. ` : ""}${isRanked ? "Every stake paid is refunded." : "Nothing was staked."}`
                  : "The duel connection has not come up. The engine may be down, or the network is blocking it."}
            </p>
            <EndActions
              game="duel"
              primary={blocked === "offline" ? { label: "Try again", onClick: () => location.reload() } : { label: "Queue again", onClick: again }}
              more={[
                { label: "Practice for free", href: duelRoute("practice"), replace: true },
                { label: "Back to the Dojo", onClick: toMenu },
              ]}
            />
          </div>
        </>
      ) : (
        <>
          <div className={s.strip}>
            <span>
              Duel <span className={s.fig}>#{duelId}</span> · {isRanked ? <>stake <span className={s.fig}>{usd(info?.stakeUnits)}</span> USDC</> : "free, no stake"}
            </span>
            <span>{status}</span>
          </div>
          <div className={s.stageBox}>
            <Stage view={view} label={`Duel ${duelId}`} />
          </div>
          {input && <Controls input={input} />}
        </>
      )}
    </main>
  );
}

function Result({ me, side, players, final, settled, verify, ranked, stakeUnits, duelId, last, back, again, watch, onEscape }: {
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
  back: Back;
  again: Action;
  watch: string;
  onEscape: () => void;
}) {
  useTitle(`Duel #${duelId} result`);
  useEscape(onEscape);
  const ws = winnerSideOf(final, players);
  const won = ws === side;
  const draw = ws === null;
  const offline = !!settled && !isTxHash(settled.txHash);
  const verdict = draw ? "A draw" : won ? "You win" : "You lose";
  const opp = players[1 - side]?.callsign ?? "your opponent";
  return (
    <main className={s.screen}>
      <Bar me={me} back={back} watch={watch} />
      <PanelHead color="duel" eyebrow={`Duel #${duelId} · ${ranked ? "ranked" : "bot fight"} · result`} title={verdict} />
      {last && (
        <div style={{ height: 190, borderBottom: "var(--stroke) solid var(--ink)" }}>
          <Stage view={() => ({ ...last, quietEnd: true })} hud={false} label="The last frame of the fight" />
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
            Replay hash<b className={s.hash}>{verify ? verify.hash : "replaying…"}</b>
          </div>
          <div>
            Replayed here<b>{verify ? (verify.matches ? `same winner, ${verify.ticks} ticks` : "does not match the engine") : "–"}</b>
          </div>
          <div>
            Book hash<b className={s.hash} title={final.bookHash}>{final.bookHash.slice(0, 10)}…{final.bookHash.slice(-6)}{verify ? (verify.bookHashOk ? " ✓" : " (differs)") : ""}</b>
          </div>
        </div>
        <EndActions game="duel" primary={again} watch={watch} more={[{ label: "Practice", href: duelRoute("practice") }]} />
      </div>
    </main>
  );
}

// ---------- mock moments ----------
// The [3, 2] bot match: in practice you are fighter 0 against the bot; in the ranked moments you are kestrel, side 1,
// who wins it 2-0. Their buttons lead to the real screens (N28).
function MockScreen({ at, me }: { at: DuelMoment; me: Me }) {
  const router = useRouter();
  const run = useMemo(() => mockRun([3, 2]), []);
  const tick = useMemo(() => pickTick(run, at === "practice" ? 200 : 620), [run, at]);
  const rep = useMemo(() => mockReplay(run), [run]);
  const input = useMemo<InputSource | null>(() => (typeof window === "undefined" ? null : createInput()), []);
  useEffect(() => () => input?.dispose(), [input]);
  useTitle(at === "practice" ? "Practice" : at === "result" ? `Duel #${MOCK_DUEL_ID} result` : `Duel #${MOCK_DUEL_ID}`);
  const youName = me.callsign || MOCK_PLAYERS[MOCK_ME].callsign;
  const players: [DuelPlayer, DuelPlayer] = [MOCK_PLAYERS[0], { ...MOCK_PLAYERS[1], callsign: youName }];
  const oppAvatar = cfgFor(MOCK_PLAYERS[0].player, MOCK_PLAYERS[0].callsign);
  const back: Back = { to: "the Dojo", href: duelRoute() };
  const watch = "/arena?mock=duel&at=fight";
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
        back={back}
        again={{ label: "Fight again", href: duelRoute() }}
        watch={watch}
        onEscape={() => router.push(duelRoute())}
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
      <Bar me={me} back={back} watch={practice ? null : watch} />
      {practice ? (
        <div className={s.levelRow}>
          <ModeSwitch current="practice" />
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
