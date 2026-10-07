"use client";
// The phone in prediction mode: rounds list, create a round, predict, locked, result, as states of /play?mode=predict.
// The island's kit with violet heads: the sea is only the losing water outside the winners' band, sun the winners and
// payouts, ink the live price.
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { PrivateKeyAccount } from "viem/accounts";
import { AppLink, BotTag, Button, Chip } from "@/components/kit";
import { EndActions, type Action } from "@/components/kit/actions";
import { PANEL, docTitle, island, playRoyale, watchGame, watchRound, type GameId } from "@/lib/nav";
import { useUrlState, type ParamSet } from "@/lib/useUrlState";
import { MARKETS, isTxHash, unitsToUsd } from "@/lib/events";
import type { RoundInfo } from "@/lib/events";
import { cfgFor } from "@/lib/island/avatar";
import { burner, createRound, join, sendPrediction, signCreateRound, signJoin, signPrediction } from "@/lib/engine";
import { useMatch, type Match } from "@/lib/useMatch";
import {
  DEFAULT_DRAFT,
  NUDGE,
  RANGES,
  SPLITS,
  centsOf,
  commas,
  countdown,
  durationStr,
  inRange,
  previewPayouts,
  priceStr,
  rememberJoined,
  useRounds,
  winnersOf,
  type Draft,
  type RangeKey,
} from "@/lib/predict";
import { PROTOCOL_LOBBY, mockMine } from "@/mocks/predict";
import { useRolling } from "@/lib/useRolling";
import { AvatarHead, useMyAvatar } from "./Avatar";
import { Shell } from "./Bar";
import { Head, figs } from "./parts";
import s from "./play.module.css";
import p from "./predict.module.css";

type View = { kind: "rounds" } | { kind: "create" } | { kind: "round"; lobby: number; createdLock?: number };

const ordinal = (n: number) => {
  const m100 = n % 100;
  const m10 = n % 10;
  if (m100 >= 11 && m100 <= 13) return `${n}th`;
  return `${n}${m10 === 1 ? "st" : m10 === 2 ? "nd" : m10 === 3 ? "rd" : "th"}`;
};
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** A price on the wire's 2-decimal grid, with thousands separators. */
const fmt = (c: bigint) => commas(priceStr(c));
/** A distance in dollars, always positive. */
const money = (c: bigint) => "$" + commas(priceStr(c < 0n ? -c : c));
const CALLSIGN = "royale.callsign";
/** The engine closes joins this long before the lock (JOIN_CLOSE_MS = 7000). */
const JOIN_CLOSE_S = 7;
const SENT = "royale.prediction";

function readStore(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function writeStore(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked */
  }
}

/** Re-render four times a second for countdowns. */
function useTick() {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 250);
    return () => clearInterval(id);
  }, []);
}

/** Moves between the predict screens (CLAUDE.md "Navigation" rule 4, N11): drill down pushes, "Rounds" and Escape go
 *  back to the list (history.back() when the list is the previous entry), a move between rounds replaces. */
type Go = {
  round: (lobby: number) => void;
  create: () => void;
  list: () => void;
  /** Another round from a round's screen, or the round just created: a lateral move, so Back still goes to the list. */
  swap: (lobby: number, lock?: number) => void;
};

/** The screen, from the URL: ?screen=create|rounds, ?lobby= (and ?lock= after creating it), else the list (live) or
 *  the protocol round (?mock=predict). */
function viewOf(q: URLSearchParams): View {
  const screen = q.get("screen");
  const lobby = Number(q.get("lobby")) || null;
  if (screen === "create") return { kind: "create" };
  if (screen === "rounds") return { kind: "rounds" };
  if (lobby) return { kind: "round", lobby, createdLock: Number(q.get("lock")) || undefined };
  if (q.get("mock") === "predict") return { kind: "round", lobby: PROTOCOL_LOBBY };
  return { kind: "rounds" };
}

export default function PredictPhone() {
  const q = useSearchParams();
  const { push, replace, back } = useUrlState();
  const mock = q.get("mock") === "predict";
  const view = viewOf(new URLSearchParams(q.toString()));
  const go = useMemo<Go>(() => {
    // The list's own URL: ?mode=predict live; ?mock=predict needs ?screen=rounds (without it the mock opens a round).
    const list: ParamSet = { screen: mock ? "rounds" : null, lobby: null, lock: null };
    const at = (set: ParamSet): ParamSet => (mock ? set : { ...set, mode: "predict" });
    const top = () => window.scrollTo(0, 0);
    return {
      round: (lobby) => (push(at({ screen: null, lobby, lock: null })), top()),
      create: () => (push(at({ screen: "create", lobby: null, lock: null })), top()),
      list: () => (back(at(list)), top()),
      swap: (lobby, lock) => (replace(at({ screen: null, lobby, lock: lock ?? null })), top()),
    };
  }, [mock, push, replace, back]);
  // Escape goes to the parent, like the back control (the kit's menus capture their own Escape first).
  useEffect(() => {
    if (view.kind === "rounds") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) go.list();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [view.kind, go]);
  return <Screens view={view} go={go} />;
}

function Screens({ view, go }: { view: View; go: Go }) {
  const match = useMatch({ predict: true, lobby: view.kind === "round" ? view.lobby : null });
  const [acct, setAcct] = useState<PrivateKeyAccount | null>(null);
  useEffect(() => setAcct(burner()), []);
  const me = match.source === "mock" ? match.me : (acct?.address.toLowerCase() ?? null);
  const st = match.state;
  const round = view.kind === "round";
  // "you're in": joined a round that has not resolved or been called off.
  const inRound = round && !!me && st.players.some((x) => x.player === me) && !st.pfinal && !st.cancelled && st.status !== "cancelled";
  const live: GameId[] | undefined = inRound ? ["predict"] : undefined;
  const title =
    view.kind === "rounds"
      ? docTitle("predict", "Rounds")
      : view.kind === "create"
        ? docTitle("predict", "Create a round")
        : docTitle("predict", `${st.pfinal ? "Result" : st.locked ? "Locked" : "Call"}, round ${view.lobby}`);
  return (
    <Shell
      game="predict"
      back={view.kind === "rounds" ? { to: "The Observatory", href: island(PANEL.predict) } : { to: "rounds", onClick: go.list }}
      live={live}
      watch={round && match.source === "live" ? watchRound(view.lobby) : watchGame("predict")}
      title={title}
    >
      {view.kind === "rounds" ? (
        <Rounds match={match} go={go} />
      ) : view.kind === "create" ? (
        <Create match={match} acct={acct} go={go} />
      ) : (
        <Round match={match} me={me} acct={acct} go={go} createdLock={view.createdLock} />
      )}
    </Shell>
  );
}

/** The big screen on this round (live), else following the protocol round. */
const watchHref = (match: Match): string =>
  match.source === "live" && match.state.lobbyId !== null ? watchRound(match.state.lobbyId) : (watchGame("predict") ?? watchRound());

/**
 * The predict end-state block (rule 5). "Next round" (N26) opens the protocol round taking calls now, not the list;
 * with none known yet (or it is this one) it falls back to the list.
 */
function RoundActions({ match, go, label = "Next round" }: { match: Match; go: Go; label?: string }) {
  const { rounds } = useRounds(match);
  const proto = rounds.find((r) => r.protocol && r.lobbyId !== match.state.lobbyId);
  const primary: Action = proto ? { label, onClick: () => go.swap(proto.lobbyId) } : { label: "See open rounds", onClick: go.list };
  return (
    <EndActions
      game="predict"
      className={s.actions}
      primary={primary}
      watch={watchHref(match)}
      more={proto ? [{ label: "See open rounds", onClick: go.list }] : undefined}
    />
  );
}

// ---------- rounds list ----------
function Rounds({ match, go }: { match: Match; go: Go }) {
  useTick();
  const { rounds, mine, error, loaded } = useRounds(match);
  const now = match.clock();
  const proto = rounds.find((r) => r.protocol);
  const users = rounds.filter((r) => !r.protocol);
  const royale = match.source === "mock" ? "/play?mock=1" : playRoyale();
  return (
    <>
    <Head game="predict" eyebrow="The Observatory" title="Call the price" />
    <section className={p.page}>
      <p className={s.lede}>Say where the price will be when the round resolves. The closest calls split the pot.</p>
      {error && <p className={s.error}>{error}</p>}
      {!loaded && <p className={s.fine}>Finding open rounds</p>}
      {proto && (
        <button className={p.proto} onClick={() => go.round(proto.lobbyId)}>
          <span className={p.protoTop}>
            <span>
              <span className={p.protoMarket}>{proto.params.market}</span>
              <span className={`${s.fig} ${p.protoMark}`}>{proto.mark ? commas(proto.mark) : "waiting"}</span>
            </span>
            <span className={p.protoClock}>
              <Chip className={p.lockChip}>Locks in</Chip>
              <span className={`${s.fig} ${p.protoCount}`}>{countdown(proto.lockTime - now)}</span>
            </span>
          </span>
          <span className={p.protoFacts}>
            <span className={s.fig}>{proto.players}</span> in, pot <span className={s.fig}>${unitsToUsd(proto.potUnits)}</span>. Closest{" "}
            <span className={s.fig}>{winnersOf(Math.max(proto.players, 4), proto.params.winnerBps)}</span> split it by rank, resolves{" "}
            {figs(durationStr(proto.endTime - proto.lockTime))} after the lock.
          </span>
          <span className={p.protoCta}>Join for <span className={s.fig}>${unitsToUsd(proto.params.entryUnits)}</span></span>
        </button>
      )}
      {mine.length > 0 && (
        <>
          <h2 className={p.h2}>Your rounds</h2>
          <ul className={p.list}>
            {mine.map((r) => (
              <li key={r.lobbyId}>
                <button className={p.row} onClick={() => go.round(r.lobbyId)}>
                  <span className={p.rowMarket}>{r.params.market}</span>
                  <span className={p.rowBody}>
                    <span className={p.rowLine}>
                      <span>Round {r.lobbyId}</span>
                      <span>
                        {r.status === "cancelled" ? (
                          "called off"
                        ) : r.status === "settled" ? (
                          "settled, see the result"
                        ) : now < r.endTime ? (
                          <>
                            resolves in <span className={s.fig}>{countdown(r.endTime - now)}</span>
                          </>
                        ) : (
                          "resolved, see the result"
                        )}
                      </span>
                    </span>
                    <span className={p.rowSub}>
                      <span className={s.fig}>{r.players}</span> in, pot <span className={s.fig}>${unitsToUsd(r.potUnits)}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h2 className={p.h2}>Rounds players made</h2>
      {users.length === 0 ? (
        <p className={p.empty}>None open right now. Make one below.</p>
      ) : (
        <ul className={p.list}>
          {users.map((r) => (
            <li key={r.lobbyId}>
              <UserRound r={r} now={now} onOpen={() => go.round(r.lobbyId)} />
            </li>
          ))}
        </ul>
      )}
      <Button color="predict" className={p.cta} onClick={go.create}>
        Create a round
      </Button>
      <AppLink className={s.link} href={royale}>
        Play Trading Royale instead
      </AppLink>
    </section>
    </>
  );
}

function UserRound({ r, now, onOpen }: { r: RoundInfo; now: number; onOpen: () => void }) {
  const fee = r.params.creatorFeeBps;
  return (
    <button className={p.row} onClick={onOpen}>
      <span className={p.rowMarket}>{r.params.market}</span>
      <span className={p.rowBody}>
        <span className={p.rowLine}>
          <span>
            <span className={s.fig}>{r.players}</span>
            {r.maxPlayers ? <> of <span className={s.fig}>{r.maxPlayers}</span></> : null} in, <span className={s.fig}>${unitsToUsd(r.params.entryUnits)}</span> entry
          </span>
          <span>
            locks in <span className={s.fig}>{countdown(r.lockTime - now)}</span>
          </span>
        </span>
        <span className={p.rowSub}>
          Top <span className={s.fig}>{r.params.winnerBps / 100}%</span> win, {r.params.split} split
          {r.params.creator ? (
            <>
              , {fee ? <><span className={s.fig}>{fee / 100}%</span> to </> : "made by "}
              <span className={s.fig}>{shortAddr(r.params.creator)}</span>
            </>
          ) : null}
        </span>
      </span>
    </button>
  );
}

// ---------- create a round ----------
const LABELS: Record<RangeKey, string> = {
  entryUnits: "Entry",
  maxPlayers: "Most players",
  lockAfter: "Calls close after",
  resolveAfter: "Resolves after the lock",
  winnerBps: "Winners",
  creatorFeeBps: "Your fee",
};

function Create({ match, acct, go }: { match: Match; acct: PrivateKeyAccount | null; go: Go }) {
  const [d, setD] = useState<Draft>(DEFAULT_DRAFT);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const pv = useMemo(() => previewPayouts(d), [d]);
  const set = (k: RangeKey, v: number) => setD((x) => ({ ...x, [k]: inRange(k, v) }));
  const k = winnersOf(d.maxPlayers, d.winnerBps);
  const show = (key: RangeKey, v: number) =>
    key === "entryUnits"
      ? `$${unitsToUsd(String(v))}`
      : key === "maxPlayers"
        ? `${v} players`
        : key === "lockAfter" || key === "resolveAfter"
          ? durationStr(v)
          : key === "winnerBps"
            ? `${v / 100}%, ${winnersOf(d.maxPlayers, v)} of ${d.maxPlayers}`
            : `${(v / 100).toFixed(1)}%`;
  const maxPay = pv.byRank.reduce((a, b) => (b > a ? b : a), 0n);
  const rows = pv.byRank.length > 8 ? [...pv.byRank.slice(0, 6), null, pv.byRank[pv.byRank.length - 1]] : pv.byRank;

  const submit = async () => {
    if (!acct || busy) return;
    setBusy(true);
    setMsg(null);
    const params = {
      market: d.market,
      entryUnits: String(inRange("entryUnits", d.entryUnits)),
      maxPlayers: inRange("maxPlayers", d.maxPlayers),
      lockAfter: inRange("lockAfter", d.lockAfter),
      resolveAfter: inRange("resolveAfter", d.resolveAfter),
      winnerBps: inRange("winnerBps", d.winnerBps),
      split: d.split,
      creatorFeeBps: inRange("creatorFeeBps", d.creatorFeeBps),
    };
    try {
      if (match.source === "mock") {
        await signCreateRound(acct, params);
        setMsg({ tone: "ok", text: "Round created. It shows up in the list once it is on chain." });
      } else {
        const r = await createRound(acct, params);
        if (!r.ok) throw new Error(String(r.data.error ?? `The engine refused the round (${r.status}).`));
        const id = Number(r.data.lobbyId);
        const lock = Number(r.data.lockTime);
        if (id) go.swap(id, lock > 0 ? lock : undefined);
      }
    } catch (e) {
      setMsg({ tone: "bad", text: e instanceof Error ? e.message : "The round was not created." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={p.create}>
      <Head game="predict" title="Create a round" />
      <div className={p.preview} aria-live="polite">
        <p className={p.previewLine}>
          If {d.maxPlayers} join, the pot is <span className={s.fig}>${unitsToUsd(pv.potUnits.toString())}</span> and the closest{" "}
          <span className={s.fig}>{k}</span> get paid
        </p>
        {pv.error ? (
          <p className={s.error}>{pv.error}</p>
        ) : (
          <ol className={p.bars}>
            {rows.map((a, i) =>
              a === null ? (
                <li key="gap" className={p.barGap}>
                  ranks <span className={s.fig}>7</span> to <span className={s.fig}>{pv.byRank.length - 1}</span>
                </li>
              ) : (
                <li key={i} className={p.bar}>
                  <span className={`${s.fig} ${p.barRank}`}>{i === rows.length - 1 && rows.length !== pv.byRank.length ? pv.byRank.length : i + 1}</span>
                  <span className={p.barTrack}>
                    <span className={p.barFill} style={{ transform: `scaleX(${maxPay ? Number((a * 1000n) / maxPay) / 1000 : 0})` }} />
                  </span>
                  <span className={`${s.fig} ${p.barAmt}`}>${unitsToUsd(a.toString())}</span>
                </li>
              ),
            )}
          </ol>
        )}
        <p className={p.previewFees}>
          You earn <span className={s.fig}>${unitsToUsd(pv.creatorFeeUnits.toString())}</span>, the treasury{" "}
          <span className={s.fig}>${unitsToUsd(pv.feeUnits.toString())}</span>
        </p>
      </div>

      <div className={p.controls}>
        <div className={p.seg} role="radiogroup" aria-label="Market">
          {MARKETS.map((m) => (
            <button key={m} role="radio" aria-checked={d.market === m} className={`${p.segBtn} ${d.market === m ? p.segOn : ""}`} onClick={() => setD((x) => ({ ...x, market: m }))}>
              {m}
            </button>
          ))}
        </div>
        {(["entryUnits", "maxPlayers", "winnerBps"] as RangeKey[]).map((key) => (
          <Slider key={key} k={key} label={LABELS[key]} value={d[key as keyof Draft] as number} show={show} set={set} />
        ))}
        <div className={p.seg} role="radiogroup" aria-label="How the winners split the pot">
          {SPLITS.map((sp) => (
            <button key={sp} role="radio" aria-checked={d.split === sp} className={`${p.segBtn} ${d.split === sp ? p.segOn : ""}`} onClick={() => setD((x) => ({ ...x, split: sp }))}>
              {sp === "equal" ? "Even split" : sp === "linear" ? "By rank" : "Steep"}
            </button>
          ))}
        </div>
        {(["lockAfter", "resolveAfter", "creatorFeeBps"] as RangeKey[]).map((key) => (
          <Slider key={key} k={key} label={LABELS[key]} value={d[key as keyof Draft] as number} show={show} set={set} />
        ))}
        <Button color="predict" className={s.go} disabled={busy || !acct || !!pv.error} onClick={submit}>
          {busy ? "Creating the round" : "Create round"}
        </Button>
        {msg && <p className={msg.tone === "bad" ? s.error : s.fine}>{figs(msg.text)}</p>}
        <p className={s.fine}>
          {figs("Calls close on a whole minute, so the lock can land up to 59 s after the time you pick. The protocol keeps 5% of every pot. You do not have to play your own round.")}
        </p>
      </div>
    </section>
  );
}

function Slider({
  k,
  label,
  value,
  show,
  set,
}: {
  k: RangeKey;
  label: string;
  value: number;
  show: (k: RangeKey, v: number) => string;
  set: (k: RangeKey, v: number) => void;
}) {
  const r = RANGES[k];
  return (
    <label className={p.slider}>
      <span className={p.sliderRow}>
        <span>{label}</span>
        <span className={`${s.fig} ${p.sliderVal}`}>{show(k, value)}</span>
      </span>
      <input
        className={s.range}
        style={{ ["--c" as string]: "var(--violet)", ["--p" as string]: `${((value - r.min) / Math.max(1, r.max - r.min)) * 100}%` }}
        type="range"
        min={r.min}
        max={r.max}
        step={r.step}
        value={value}
        aria-valuetext={show(k, value)}
        onChange={(e) => set(k, Number(e.target.value))}
      />
    </label>
  );
}

// ---------- one round: join, predict, locked, result ----------
function Round({
  match,
  me,
  acct,
  go,
  createdLock,
}: {
  match: Match;
  me: string | null;
  acct: PrivateKeyAccount | null;
  go: Go;
  createdLock?: number;
}) {
  const st = match.state;
  if (st.error) return <Notice match={match} title="Not connected" body={st.error} go={go} />;
  if (!st.round) return <p className={s.waiting}>Finding the round</p>;
  if (st.cancelled || st.status === "cancelled")
    return (
      <Notice
        match={match}
        title="This round was called off"
        body={`${st.cancelReason ? `${sentenceCase(st.cancelReason)}. ` : ""}Every entry is refunded on chain.`}
        go={go}
      />
    );
  const joined = !!me && st.players.some((x) => x.player === me);
  if (st.pfinal) return <Result match={match} me={me} go={go} />;
  if (st.locked) return <Locked match={match} me={me} go={go} />;
  if (!joined) return <JoinRound match={match} acct={acct} me={me} go={go} createdLock={createdLock} />;
  return <Call match={match} me={me!} acct={acct} go={go} />;
}

function Notice({ match, title, body, go }: { match: Match; title: string; body: string; go: Go }) {
  return (
    <section className={s.out} role="alert">
      <Head game="predict" eyebrow="The Observatory" title={title} />
      <div className={p.page}>
        <p className={s.lede}>{body}</p>
        <RoundActions match={match} go={go} />
      </div>
    </section>
  );
}

/** The round's head: back to the rounds and the round's clock, the round as the title, then whatever the screen adds. */
function RoundBar({ match, go, right, urgent, children }: { match: Match; go: Go; right: React.ReactNode; urgent?: boolean; children?: React.ReactNode }) {
  const r = match.state.round!;
  return (
    <Head
      game="predict"
      className={p.roundHead}
      top={
<Chip className={`${p.barRight} ${urgent ? p.urgentChip : ""}`}>{right}</Chip>
      }
      title={`${r.params.market} round ${r.lobbyId}`}
    >
      {children}
    </Head>
  );
}

/** Your head and callsign, small, beside your call. */
function MeInline({ me, callsign }: { me: string | null; callsign: string | undefined }) {
  const cfg = useMyAvatar(me, callsign ?? "");
  if (!cfg || !callsign) return null;
  return (
    <span className={`${s.me} ${p.meInline}`}>
      <AvatarHead cfg={cfg} size={28} />
      <span className={s.meName}>{callsign}</span>
    </span>
  );
}

/** Your head and callsign, inside a round's head. */
function MeLine({ me, callsign }: { me: string | null; callsign: string | undefined }) {
  const cfg = useMyAvatar(me, callsign ?? "");
  if (!cfg || !callsign) return null;
  return (
    <div className={s.headMe}>
      <span className={s.me}>
        <AvatarHead cfg={cfg} size={34} />
        <span className={s.meName}>{callsign}</span>
      </span>
    </div>
  );
}

/** Local wall-clock time of a unix-seconds timestamp, to the second. */
const clockOf = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const sentenceCase = (x: string) => x.charAt(0).toUpperCase() + x.slice(1).replace(/[.\s]+$/, "");

/** The live price, rolling toward each new mark instead of jumping (display only; nothing signed reads it). */
function LivePrice({ match, mark }: { match: Match; mark: bigint | null }) {
  const v = useRolling(mark === null ? 0 : Number(mark) / 100, match.reducedMotion);
  return <p className={`${s.fig} ${p.live}`}>{mark === null ? "waiting" : commas(v.toFixed(2))}</p>;
}

const liveMark = (match: Match): bigint | null => {
  const st = match.state;
  const last = st.ptick?.mark ?? (st.path.length ? st.path[st.path.length - 1].p.toFixed(2) : null);
  return centsOf(last);
};

function JoinRound({
  match,
  acct,
  me,
  go,
  createdLock,
}: {
  match: Match;
  acct: PrivateKeyAccount | null;
  me: string | null;
  go: Go;
  createdLock?: number;
}) {
  useTick();
  const st = match.state;
  const r = st.round!;
  const [callsign, setCallsign] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setCallsign(readStore(CALLSIGN) ?? ""), []);
  const valid = callsign.trim().length >= 1 && callsign.trim().length <= 24;
  const left = r.lockTime - match.clock();
  const closedJoins = left <= JOIN_CLOSE_S;
  const mark = liveMark(match);
  const submit = async () => {
    if (!acct || !valid || busy || closedJoins) return;
    setBusy(true);
    setErr(null);
    const cs = callsign.trim();
    writeStore(CALLSIGN, cs);
    try {
      if (match.source === "mock") {
        await signJoin(acct, r.lobbyId, cs);
        const players = [...st.players, { player: me ?? acct.address.toLowerCase(), callsign: cs, bot: false }];
        match.inject({ type: "lobby", status: "open", players, startsAt: r.lockTime, endTime: r.endTime, lobbyId: r.lobbyId, mode: "predict", potUnits: (BigInt(players.length) * BigInt(r.params.entryUnits)).toString() });
      } else {
        const res = await join(acct, r.lobbyId, cs);
        if (!res.ok) throw new Error(String(res.data.error ?? `The engine refused the join (${res.status}).`));
      }
      rememberJoined(r.lobbyId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The join did not go through. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={s.out}>
      <RoundBar match={match} go={go} right={<>Locks in <b>{countdown(left)}</b></>} urgent={left <= 10} />
      <div className={p.page}>
      {createdLock ? (
        <p className={s.fine}>
          Round created. Calls close at <span className={s.fig}>{clockOf(createdLock)}</span>, lined up with the minute.
        </p>
      ) : null}
      <p className={s.kicker}>{r.params.market} now</p>
      <LivePrice match={match} mark={mark} />
      <p className={s.lede}>
        <span className={s.fig}>{st.players.length}</span> in, pot <span className={s.fig}>${unitsToUsd(st.potUnits)}</span>. The closest{" "}
        <span className={s.fig}>{r.params.winnerBps / 100}%</span> of players split it {r.params.split === "equal" ? "evenly" : r.params.split === "steep" ? "steeply by rank" : "by rank"}, after
        a <span className={s.fig}>5%</span> protocol fee{r.params.creator && r.params.creatorFeeBps ? <> and a <span className={s.fig}>{r.params.creatorFeeBps / 100}%</span> creator fee</> : ""}.
      </p>
      <label className={s.field}>
        <span>Your callsign</span>
        <span className={s.fieldRow}>
          <CallsignHead me={me} callsign={callsign} />
          <input value={callsign} maxLength={24} autoComplete="off" onChange={(e) => setCallsign(e.target.value)} placeholder="A name for the big screen" />
        </span>
      </label>
      <Button color="predict" className={s.go} disabled={!valid || busy || !acct || closedJoins} onClick={submit}>
        {closedJoins ? "Joins are closed for this round" : busy ? "Joining" : figs(`Join for $${unitsToUsd(r.params.entryUnits)}`)}
      </Button>
      {err && <p className={s.error}>{err}</p>}
      <p className={s.fine}>The entry is paid for you. Your game key stays in this browser.</p>
      </div>
    </section>
  );
}

function CallsignHead({ me, callsign }: { me: string | null; callsign: string }) {
  const cfg = useMyAvatar(me, callsign);
  return cfg ? <AvatarHead cfg={cfg} size={46} /> : null;
}

/** The predict screen: live price, your call, a tape to drag and buttons to nudge it, the lock countdown. */
function Call({ match, me, acct, go }: { match: Match; me: string; acct: PrivateKeyAccount | null; go: Go }) {
  useTick();
  const st = match.state;
  const r = st.round!;
  const market = r.params.market;
  const mark = liveMark(match);
  const storeKey = `${SENT}.${r.lobbyId}.${me}`;
  const [draft, setDraft] = useState<bigint | null>(null);
  const [localSent, setSent] = useState<string | null>(null);
  const sentAt = useRef(-1e9);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  // Start once: from what this phone already sent, else from the live price as soon as there is one.
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current) return;
    let prev = readStore(storeKey);
    if (!prev && match.source === "mock" && match.mockSeed !== null) {
      const m = mockMine(r.lobbyId, match.mockSeed);
      if (m && match.clock() >= m.at) prev = m.price;
    }
    if (prev && centsOf(prev) !== null) {
      inited.current = true;
      setSent(prev);
      setDraft(centsOf(prev));
    } else if (mark !== null) {
      inited.current = true;
      setDraft(mark);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey, match.source, match.mockSeed, r.lobbyId, mark]);
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 2600);
    return () => clearTimeout(id);
  }, [msg]);

  const left = r.lockTime - match.clock();
  const price = draft !== null ? priceStr(draft) : null;
  // The engine's players[].predicted is the truth for whether a call is in; this phone's copy only supplies the price.
  // A call sent in the last 6 s counts even before the next snapshot shows it.
  const engineSays = st.predictedBy[me];
  const fresh = performance.now() - sentAt.current < 6000;
  const sent = engineSays === false && !fresh ? null : localSent;
  const elsewhere = engineSays === true && sent === null;
  const changed = price !== null && price !== sent;
  const diff = draft !== null && mark !== null ? draft - mark : null;
  const n = NUDGE[market];

  const submit = async () => {
    if (!acct || price === null || busy) return;
    setBusy(true);
    try {
      if (match.source === "mock") {
        await signPrediction(acct, r.lobbyId, price);
        if (!sent) match.inject({ type: "predicted", t: match.clock() - (st.tOrigin ?? r.lockTime - 60), count: st.predictedCount + 1, lobbyId: r.lobbyId });
      } else {
        const res = await sendPrediction(acct, r.lobbyId, price, st.serverOffsetMs);
        if (!res.ok) throw new Error(String(res.data.error ?? `The engine refused the call (${res.status}).`));
      }
      writeStore(storeKey, price);
      sentAt.current = performance.now();
      setSent(price);
      setMsg({ tone: "ok", text: sent ? `Call moved to ${commas(price)}` : `Call sent: ${commas(price)}` });
    } catch (e) {
      setMsg({ tone: "bad", text: e instanceof Error ? e.message : "The call did not go through." });
    } finally {
      setBusy(false);
    }
  };

  const sentence =
    diff === null
      ? "Waiting for the live price."
      : diff === 0n
        ? "Right on the live price."
        : `${money(diff)} ${diff > 0n ? "above" : "below"} the live price.`;

  return (
    <section className={p.call}>
      <RoundBar match={match} go={go} right={<>Locks in <b>{countdown(left)}</b></>} urgent={left <= 10} />
      <div className={p.callBody}>
      <div className={p.callTop}>
        <p className={s.kicker}>{market} now</p>
        <LivePrice match={match} mark={mark} />
      </div>
      <div className={p.mine}>
        <div className={p.mineTop}>
        <p className={s.kicker}>
          {sent ? (changed ? "Your new call, not sent" : "Your call") : elsewhere ? "Your call is in, sent from another device" : "Your call, not sent yet"}
        </p>
        <MeInline me={me} callsign={st.players.find((x) => x.player === me)?.callsign} />
        </div>
        <p className={`${s.fig} ${p.callFig}`}>{price !== null ? commas(price) : "—"}</p>
        <p className={p.diff}>{figs(sentence)}</p>
      </div>
      <p className={p.count}>
        <b>{st.predictedCount}</b> of <b>{st.players.length}</b> have called. Calls stay sealed until the lock.
      </p>
      <Sketch match={match} call={draft} />
      <div className={p.thumb}>
        <Tape value={draft} mark={mark} px={n.px} onChange={(v) => setDraft(v < 1n ? 1n : v)} />
        <div className={p.nudges}>
          <button className={p.nudge} disabled={draft === null} onClick={() => setDraft((v) => (v === null ? v : v - n.step < 1n ? 1n : v - n.step))}>
            −{money(n.step)}
          </button>
          <button className={p.nudge} disabled={mark === null} onClick={() => setDraft(mark)}>
            Live price
          </button>
          <button className={p.nudge} disabled={draft === null} onClick={() => setDraft((v) => (v === null ? v : v + n.step))}>
            +{money(n.step)}
          </button>
        </div>
        {sent && !changed ? (
          <p className={p.sentNote} role="status">
            Sent. Drag the tape or nudge it to move your call until the lock.
          </p>
        ) : (
          <Button color="predict" big className={s.go} disabled={busy || !acct || left <= 0 || price === null} onClick={submit}>
            {busy ? "Sending" : figs(sent || elsewhere ? `Move my call to ${commas(price ?? "")}` : `Call ${price !== null ? commas(price) : ""}`)}
          </Button>
        )}
      </div>
      </div>
      {msg && <p className={`${s.toast} ${msg.tone === "bad" ? s.toastBad : ""}`}>{figs(msg.text)}</p>}
    </section>
  );
}

/** The price since the round opened, with your call as a line: where it has been against where you say it goes. */
function Sketch({ match, call }: { match: Match; call: bigint | null }) {
  const st = match.state;
  const r = st.round!;
  const W = 358;
  const H = 118;
  const u0 = st.tOrigin ?? st.path[0]?.u ?? r.lockTime - 60;
  const u1 = r.endTime;
  const pts = st.path.filter((q) => q.u >= u0);
  if (!pts.length) return <div className={p.sketchEmpty} />;
  const vals = pts.map((q) => q.p);
  if (call !== null) vals.push(Number(call) / 100);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.12, hi * 0.0003);
  lo -= pad;
  hi += pad;
  const x = (u: number) => ((u - u0) / Math.max(1, u1 - u0)) * W;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const stride = Math.max(1, Math.ceil(pts.length / 240));
  let d = "";
  pts.forEach((q, i) => {
    if (i % stride && i !== pts.length - 1) return;
    d += `${d ? "L" : "M"}${x(q.u).toFixed(1)} ${y(q.p).toFixed(1)}`;
  });
  const last = pts[pts.length - 1];
  const lockX = x(r.lockTime);
  const cy = call !== null ? y(Number(call) / 100) : null;
  return (
    <svg className={p.sketch} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="The price since the round opened, your call, the lock and the resolve">
      <rect x={lockX} y={0} width={W - lockX} height={H} className={p.sketchAhead} />
      <line x1={lockX} x2={lockX} y1={0} y2={H} className={p.sketchPost} />
      <text x={lockX + 6} y={16} className={p.sketchLabel}>
        lock
      </text>
      <text x={W - 6} y={16} className={p.sketchLabel} textAnchor="end">
        resolve
      </text>
      {cy !== null && <line x1={0} x2={W} y1={cy} y2={cy} className={p.sketchCall} />}
      <path d={d} className={p.sketchTrace} />
      <circle cx={x(last.u)} cy={y(last.p)} r={5} className={p.markDot} />
    </svg>
  );
}

/**
 * A survey tape under a fixed needle. Drag it sideways; each pixel is `px` cents. The live price is marked on it.
 * Arrow keys nudge by one pixel's worth, Page keys by ten.
 */
function Tape({ value, mark, px, onChange }: { value: bigint | null; mark: bigint | null; px: bigint; onChange: (v: bigint) => void }) {
  const drag = useRef<{ x: number; v: bigint } | null>(null);
  const W = 358;
  const H = 76;
  const v = value ?? mark ?? 0n;
  const tick = px * 10n; // a tick every 10 px
  const first = ((v - tick * 20n) / tick) * tick;
  const ticks: { x: number; big: boolean; label: string | null }[] = [];
  for (let c = first; c <= v + tick * 20n; c += tick) {
    const x = W / 2 + Number(c - v) / Number(px);
    if (x < -20 || x > W + 20) continue;
    const big = (c / tick) % 5n === 0n;
    ticks.push({ x, big, label: big ? commas(priceStr(c)).replace(/\.00$/, "") : null });
  }
  const markX = mark !== null ? W / 2 + Number(mark - v) / Number(px) : null;
  return (
    <div
      className={p.tape}
      role="slider"
      tabIndex={0}
      aria-label="Your call. Drag sideways or use the arrow keys."
      aria-valuenow={Number(v) / 100}
      aria-valuetext={value !== null ? priceStr(value) : "no call"}
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, v };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const dx = Math.round(e.clientX - drag.current.x);
        onChange(drag.current.v - BigInt(dx) * px);
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={(e) => {
        const k = { ArrowLeft: -px, ArrowDown: -px, ArrowRight: px, ArrowUp: px, PageDown: -px * 10n, PageUp: px * 10n }[e.key];
        if (k !== undefined) {
          e.preventDefault();
          onChange(v + k);
        }
      }}
    >
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={t.x} x2={t.x} y1={t.big ? 30 : 42} y2={H} className={p.tapeTick} />
            {t.label && (
              <text x={t.x} y={22} className={p.tapeLabel} textAnchor="middle">
                {t.label}
              </text>
            )}
          </g>
        ))}
        {markX !== null && markX > -10 && markX < W + 10 && (
          <path d={`M${markX - 7} ${H} L${markX} ${H - 12} L${markX + 7} ${H} Z`} className={p.tapeMark} />
        )}
        <line x1={W / 2} x2={W / 2} y1={26} y2={H} className={p.tapeNeedle} />
      </svg>
    </div>
  );
}

/** After the lock: where the player sits against the live price, the storm and the winning band. */
function Locked({ match, me, go }: { match: Match; me: string | null; go: Go }) {
  useTick();
  const st = match.state;
  const r = st.round!;
  const lk = st.locked!;
  const tk = st.ptick;
  const left = r.endTime - match.clock();
  const mark = liveMark(match);
  const mine = lk.predictions.find((x) => x.player === me);
  const myC = mine ? centsOf(mine.price) : null;
  const ranked = useMemo(() => {
    if (mark === null) return [];
    return lk.predictions
      .map((x) => {
        const c = centsOf(x.price) ?? 0n;
        return { ...x, c, d: c > mark ? c - mark : mark - c, j: st.players.findIndex((q) => q.player === x.player) };
      })
      .sort((a, b) => (a.d !== b.d ? (a.d < b.d ? -1 : 1) : a.j - b.j));
  }, [lk, mark, st.players]);
  const k = tk?.leaders.length ?? winnersOf(st.players.length, r.params.winnerBps);
  const myRank = mine ? ranked.findIndex((x) => x.player === me) + 1 : 0;
  const inside = myRank > 0 && myRank <= k;
  const resolving = left <= 0;
  const sentence = !mine
    ? me && st.players.some((x) => x.player === me)
      ? "You did not make a call this round, so you cannot win it."
      : "You are watching this round."
    : mark === null || myC === null
      ? "Waiting for the live price."
      : inside
        ? `You are ${ordinal(myRank)} closest, ${money(myC - mark)} from the price. The closest ${k} win.`
        : `You are ${ordinal(myRank)}, ${money(myC - mark)} from the price. Only the closest ${k} win.`;
  return (
    <section className={s.out}>
      <RoundBar match={match} go={go} right={resolving ? "Reading the price" : <>Resolves in <b>{countdown(left)}</b></>}>
        <MeLine me={me} callsign={mine?.callsign} />
      </RoundBar>
      <div className={p.page}>
      <p className={s.kicker}>{r.params.market} now</p>
      <LivePrice match={match} mark={mark} />
      <p className={`${s.sentence} ${mine && !inside ? s.sentenceDanger : ""}`} role="status">
        {figs(sentence)}
      </p>
      <Strip match={match} me={me} />
      <h2 className={p.h2}>Winning now</h2>
      <ol className={p.leaders}>
        {ranked.slice(0, k).map((x, i) => (
          <li key={x.player} className={x.player === me ? s.meRow : ""}>
            <span className={p.rk}>{i + 1}</span>
            <Who player={x.player} callsign={x.callsign} bot={x.bot} me={me} />
            <span className={s.fig}>{commas(x.price)}</span>
            <span className={`${s.fig} ${p.dist}`}>{money(x.d)}</span>
          </li>
        ))}
      </ol>
      <RoundActions match={match} go={go} label="Call the next round" />
      </div>
    </section>
  );
}

/** A player's head and callsign in a row; yours from your saved look. */
function Who({ player, callsign, bot, me }: { player: string; callsign: string; bot: boolean; me: string | null }) {
  const mine = useMyAvatar(player === me ? player : null, callsign);
  return (
    <span className={s.who}>
      <AvatarHead cfg={mine ?? cfgFor(player, callsign)} size={26} />
      <span>
        {callsign}
        {bot && <BotTag />}
      </span>
    </span>
  );
}

/** A vertical slice of the arena map: every call as a tick, the storm outside the winners' band, the live price. */
function Strip({ match, me }: { match: Match; me: string | null }) {
  const st = match.state;
  const lk = st.locked!;
  const band = st.ptick?.band;
  const mark = liveMark(match);
  const W = 358;
  const H = 260;
  const vals = lk.predictions.map((x) => Number(x.price));
  if (mark !== null) vals.push(Number(mark) / 100);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.08, hi * 0.0002);
  lo -= pad;
  hi += pad;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const leaders = new Set(st.ptick?.leaders.map((l) => l.player) ?? []);
  const bTop = band ? y(Number(band.high)) - 6 : 0;
  const bBot = band ? y(Number(band.low)) + 6 : H;
  const my = lk.predictions.find((x) => x.player === me);
  return (
    <svg className={p.strip} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Every call against the live price; the storm covers the calls that are losing right now">
      {band && (
        <>
          <rect x={0} y={0} width={W} height={Math.max(0, bTop)} className={p.storm} />
          <rect x={0} y={bBot} width={W} height={Math.max(0, H - bBot)} className={p.storm} />
          <line x1={0} x2={W} y1={bTop - 3} y2={bTop - 3} className={p.stormShallow} />
          <line x1={0} x2={W} y1={bBot + 3} y2={bBot + 3} className={p.stormShallow} />
          <line x1={0} x2={W} y1={bTop} y2={bTop} className={p.stormEdge} />
          <line x1={0} x2={W} y1={bBot} y2={bBot} className={p.stormEdge} />
        </>
      )}
      {lk.predictions.map((x) => (
        <line
          key={x.player}
          x1={x.player === me ? 0 : 150}
          x2={W}
          y1={y(Number(x.price))}
          y2={y(Number(x.price))}
          className={leaders.has(x.player) ? p.callWin : p.callLose}
        />
      ))}
      {my && (
        <>
          <line x1={0} x2={W} y1={y(Number(my.price))} y2={y(Number(my.price))} className={p.callMe} />
          <text x={6} y={y(Number(my.price)) - 6} className={p.stripMe}>
            You <tspan className={p.figT}>{commas(my.price)}</tspan>
          </text>
        </>
      )}
      {mark !== null && (
        <>
          <line x1={0} x2={W} y1={y(Number(mark) / 100)} y2={y(Number(mark) / 100)} className={p.markLine} />
          <circle cx={W - 10} cy={y(Number(mark) / 100)} r={6} className={p.markDot} />
        </>
      )}
    </svg>
  );
}

function Result({ match, me, go }: { match: Match; me: string | null; go: Go }) {
  const st = match.state;
  const r = st.round!;
  const fin = st.pfinal!;
  const settled = st.settled;
  const paid = (who: string) => {
    if (!settled) return null;
    const i = settled.winners.indexOf(who);
    return i >= 0 ? settled.amounts[i] : "0";
  };
  const win = fin.winners.find((w) => w.player === me);
  const mine = st.locked?.predictions.find((x) => x.player === me);
  const sp = centsOf(fin.settlementPrice)!;
  const myC = mine ? centsOf(mine.price) : null;
  const winners = [...fin.winners].sort((a, b) => a.rank - b.rank);
  const units = win ? (paid(win.player) ?? win.provisionalPayoutUnits) : null;
  return (
    <section className={s.out}>
      <RoundBar match={match} go={go} right={settled ? "Settled" : "Resolved"}>
        <MeLine me={me} callsign={mine?.callsign ?? win?.callsign} />
      </RoundBar>
      <div className={p.page}>
      <p className={s.kicker}>{r.params.market} settled at</p>
      <p className={`${s.fig} ${p.settle}`}>{commas(fin.settlementPrice)}</p>
      {win ? (
        <>
          <h2 className={p.resultTitle}>{win.rank === 1 ? "Closest call in the round" : figs(`${ordinal(win.rank)} closest. You win.`)}</h2>
          <p className={s.payout}>${unitsToUsd(units ?? "0")}</p>
          <p className={s.sub}>
            {settled ? (isTxHash(settled.txHash) ? "Paid to your address" : "Settled offline (no chain), nothing paid") : "Provisional, until the settlement report lands"}. You called{" "}
            <span className={s.fig}>{commas(win.price)}</span>, off by <span className={s.fig}>{commas(win.distance)}</span>.
          </p>
        </>
      ) : mine && myC !== null ? (
        <>
          <h2 className={p.resultTitle}>Not close enough this time</h2>
          <p className={s.sub}>
            You called <span className={s.fig}>{commas(mine.price)}</span>, off by <span className={s.fig}>{money(myC - sp)}</span>. The last winning call was off by{" "}
            <span className={s.fig}>{commas(winners[winners.length - 1]?.distance ?? "0.00")}</span>.
          </p>
        </>
      ) : (
        <h2 className={p.resultTitle}>{winners[0] ? `${winners[0].callsign} called it closest` : "Nobody made a call"}</h2>
      )}
      <ol className={p.leaders}>
        {winners.map((w) => (
          <li key={w.player} className={w.player === me ? s.meRow : ""}>
            <span className={p.rk}>{w.rank}</span>
            <Who player={w.player} callsign={w.callsign} bot={!!st.players.find((x) => x.player === w.player)?.bot} me={me} />
            <span className={`${s.fig} ${p.dist}`}>{commas(w.distance)}</span>
            <span className={s.fig}>${unitsToUsd(paid(w.player) ?? w.provisionalPayoutUnits)}</span>
          </li>
        ))}
      </ol>
      {settled ? (
        isTxHash(settled.txHash) ? (
          <div className={s.stamp}>
            <p className={s.stampTitle}>Verified by Chainlink</p>
            <p className={s.stampBody}>
              Settled on chain, tx <span className={s.fig}>{shortAddr(settled.txHash)}</span>
            </p>
            <p className={s.stampBody}>{settled.mode === "deployed" ? "Paid by the CRE workflow report" : "Paid from a simulated CRE report"}</p>
          </div>
        ) : (
          <div className={s.stamp}>
            <p className={`${s.stampTitle} ${s.stampOff}`}>Settled offline (no chain)</p>
            <p className={s.stampBody}>This engine runs without a chain, so nothing was paid on chain.</p>
          </div>
        )
      ) : (
        <p className={s.fine}>Payouts are provisional until the Chainlink report settles the pot.</p>
      )}
      <RoundActions match={match} go={go} />
      </div>
    </section>
  );
}

