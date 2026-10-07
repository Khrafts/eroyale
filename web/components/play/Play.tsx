"use client";
// The phone: join, lobby, trade, eliminated, result, as states of one screen.
// The island's panel at full screen: paper, the kit's top bar back to the island, coral heads for Trading Royale,
// mint long, violet short, profit and loss as sun and coral chips, the island's sea only for the zone.
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { PrivateKeyAccount } from "viem/accounts";
import { AppLink, BotTag as KitBotTag, Button, Chip, GhostButton } from "@/components/kit";
import { EndActions, type Action } from "@/components/kit/actions";
import { MARKETS, START_BALANCE, STAGE, isTxHash, num, unitsToUsd } from "@/lib/events";
import type { EliminatedEvent, FillEvent, Market, Side } from "@/lib/events";
import { burner, join, sendOrder, signOrder, type Order } from "@/lib/engine";
import { useMatch, type Match } from "@/lib/useMatch";
import { PANEL, docTitle, island, predictRounds, watchGame, watchLobby, type GameId } from "@/lib/nav";
import { useUrlState } from "@/lib/useUrlState";
import { useRolling } from "@/lib/useRolling";
import { MEANING } from "@/lib/theme";
import { AvatarHead, PlayerHead, useMyAvatar } from "./Avatar";
import { Head, Pennant, figs, Settling, WaitingClose, LoadBar } from "./parts";
import { hasEnded, provisionalFinal } from "@/lib/provisional";
import { EmptyShell, Shell } from "./Bar";
import s from "./play.module.css";
import PredictPhone from "./Predict";

const CALLSIGN = "royale.callsign";

const DETENTS = [10, 25, 50, 100];
const SIZES: { label: string; frac: number }[] = [
  { label: "10%", frac: 0.1 },
  { label: "25%", frac: 0.25 },
  { label: "50%", frac: 0.5 },
  { label: "All", frac: 1 },
];

const usd = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const clockStr = (sec: number) => {
  const v = Math.max(0, Math.ceil(sec));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
};
const ordinal = (n: number) => {
  const m100 = n % 100;
  const m10 = n % 10;
  if (m100 >= 11 && m100 <= 13) return `${n}th`;
  return `${n}${m10 === 1 ? "st" : m10 === 2 ? "nd" : m10 === 3 ? "rd" : "th"}`;
};
const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

/** Small altitude gauge: the flood, the cut line, and you. */
function Gauge({ equity, cut, zone }: { equity: number; cut: number; zone: number }) {
  const lo = Math.min(equity, cut, zone) - 250;
  const hi = Math.max(equity, cut, zone) + 250;
  const y = (v: number) => 150 - ((v - lo) / (hi - lo)) * 140 - 5;
  const below = equity < cut;
  return (
    <svg className={s.gauge} viewBox="0 0 64 150" role="img" aria-label="Your altitude against the cut line and the flood">
      <rect x="0" y={y(zone)} width="64" height={150 - y(zone)} className={s.gaugeFlood} />
      <rect x="0" y={y(zone)} width="64" height="7" className={s.gaugeShallow} />
      <line x1="0" x2="64" y1={y(zone)} y2={y(zone)} className={s.gaugeFoam} />
      <line x1="0" x2="64" y1={y(cut)} y2={y(cut)} className={s.gaugeCut} />
      <path
        d={`M14 ${y(equity) + 13} L32 ${y(equity) - 9} L50 ${y(equity) + 13} Z`}
        className={below ? s.gaugeMeLow : s.gaugeMe}
      />
    </svg>
  );
}

type Toast = { text: string; tone: "ok" | "bad" } | null;

/** Royale or prediction mode, from ?mode=predict or ?mock=predict. The URL is read with useSearchParams so an in-app
 *  link (the switcher, an action block) that changes it re-renders the right mode without a reload. */
export default function Play() {
  return (
    <Suspense fallback={<EmptyShell />}>
      <Modes />
    </Suspense>
  );
}

function Modes() {
  const q = useSearchParams();
  if (q.get("mock") === "predict" || q.get("mode") === "predict") return <PredictPhone />;
  // A pinned ?lobby= and the followed lobby are different matches: remount when it changes.
  return <RoyalePhone key={q.get("lobby") ?? ""} />;
}

type Kind = "error" | "finding" | "cancelled" | "eliminated" | "result" | "join" | "lobby" | "spectate" | "trade";
const TITLES: Record<Kind, string> = {
  error: "Not connected",
  finding: "Finding the lobby",
  cancelled: "Called off",
  eliminated: "You went under",
  result: "Result",
  join: "Join",
  lobby: "Lobby",
  spectate: "Watching",
  trade: "Trade",
};

type MyElim = { ev: EliminatedEvent; p: EliminatedEvent["players"][number] } | null;

function kindOf(match: Match, inLobby: boolean, myElim: MyElim): Kind {
  const { state } = match;
  if (state.error) return "error";
  if (!state.status) return "finding";
  if (state.status === "cancelled") return "cancelled";
  if (state.final || state.status === "settling" || state.status === "settled" || hasEnded(state, match.clock())) return myElim ? "eliminated" : "result";
  if (!inLobby && (state.status === "open" || state.status === "countdown")) return "join";
  if (state.status === "open" || state.status === "countdown") return "lobby";
  if (myElim) return "eliminated";
  if (!inLobby) return "spectate";
  return "trade";
}

function RoyalePhone() {
  const match = useMatch({ hold: true });
  const { state, source } = match;
  const [acct, setAcct] = useState<PrivateKeyAccount | null>(null);
  const [joinedAs, setJoinedAs] = useState<string | null>(null);
  useEffect(() => setAcct(burner()), []);
  // re-render once a second while live, so the result shows the moment the match clock passes the end
  const [, tickNow] = useState(0);
  useEffect(() => {
    if (state.status !== "live" || state.final) return;
    const id = setInterval(() => tickNow((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [state.status, state.final]);

  const me = source === "mock" ? match.me : (acct?.address.toLowerCase() ?? null);
  const inLobby = (!!me && state.players.some((p) => p.player === me)) || !!joinedAs;
  const myElim = useMemo<MyElim>(() => {
    for (const e of state.eliminations) {
      const p = e.players.find((x) => x.player === me);
      if (p) return { ev: e, p };
    }
    return null;
  }, [state.eliminations, me]);
  const kind = kindOf(match, inLobby, myElim);
  // "you're in" (N35): alive in a lobby that has not ended.
  const live: GameId[] | undefined = kind === "lobby" || kind === "trade" ? ["royale"] : undefined;
  const id = state.lobbyId;

  return (
    <Shell
      game="royale"
      back={{ to: "The Arena", href: island(PANEL.royale) }}
      live={live}
      watch={id !== null && (source === "live" || match.pinned) ? watchLobby(id) : watchGame("royale")}
      title={docTitle("royale", id !== null && kind !== "join" ? `${TITLES[kind]}, lobby ${id}` : TITLES[kind])}
    >
      <Body match={match} me={me} kind={kind} myElim={myElim} acct={acct} onJoined={setJoinedAs} />
    </Shell>
  );
}

function Body({
  match,
  me,
  kind,
  myElim,
  acct,
  onJoined,
}: {
  match: Match;
  me: string | null;
  kind: Kind;
  myElim: MyElim;
  acct: PrivateKeyAccount | null;
  onJoined: (c: string) => void;
}) {
  const { state } = match;
  switch (kind) {
    case "error":
      return <Notice title="Not connected" body={state.error!} actions={<Retry />} />;
    case "finding":
      return <Notice title="Finding the lobby" body="Asking the engine which lobby is open. This takes a second or two." actions={<LoadBar label="Connecting to the engine" />} />;
    case "cancelled":
      return (
        <Notice
          title="This match was called off"
          body={
            match.pinned
              ? "Not enough players made it in. Every entry is refunded on chain."
              : "Not enough players made it in. Every entry is refunded on chain. The next lobby opens here as soon as the engine has one."
          }
          actions={<RoyaleActions match={match} />}
        />
      );
    case "eliminated":
      return <Eliminated match={match} me={me!} elim={myElim!} />;
    case "result":
      return <Result match={match} me={me} />;
    case "join":
      return <Join match={match} acct={acct} onJoined={onJoined} />;
    case "lobby":
      return <Lobby match={match} />;
    case "spectate":
      return <Spectate match={match} />;
    default:
      return <Trade match={match} me={me!} acct={acct} />;
  }
}

/** The big screen on this lobby (live or pinned), else following royale. */
const watchHref = (match: Match): string => (match.state.lobbyId !== null && (match.source === "live" || match.pinned) ? watchLobby(match.state.lobbyId) : (watchGame("royale") ?? "/arena"));

/**
 * The royale end-state block (rule 5, rule 8). Primary: on a pinned lobby "Go to the current lobby" (drops ?lobby);
 * on the followed lobby "Play the next lobby", which moves on to the engine's next lobby once it is open (the screen
 * holds the result until then). `primary` overrides it (spectate, lobby).
 */
function RoyaleActions({ match, primary, watch = true }: { match: Match; primary?: Action; watch?: boolean }) {
  const { replace } = useUrlState();
  // Asked to move on before the engine has opened the next lobby: move as soon as it has.
  const [asked, setAsked] = useState(false);
  const { next, followNext } = match;
  useEffect(() => {
    if (asked && next !== null) followNext();
  }, [asked, next, followNext]);
  const main: Action =
    primary ??
    (match.pinned
      ? // pin straight to the engine's current lobby once it is known (its join screen), else unpin and find it
        next !== null
        ? { label: "Join the current lobby", onClick: () => replace({ lobby: String(next) }) }
        : { label: "Go to the current lobby", onClick: () => replace({ lobby: null }) }
      : next !== null
        ? { label: "Play the next lobby", onClick: followNext }
        : { label: asked ? "Opening the next lobby" : "Play the next lobby", onClick: () => setAsked(true) });
  return (
    <EndActions
      game="royale"
      className={s.actions}
      primary={main}
      watch={watch ? watchHref(match) : null}
    />
  );
}

/** "The next lobby is open" (rule 8): the held screen says so instead of moving on by itself. */
function NextChip({ match }: { match: Match }) {
  if (match.next === null) return null;
  return (
    <Chip className={s.nextChip} role="status">
      Lobby <b className={s.fig}>{match.next}</b> is open
    </Chip>
  );
}

/** Reload the page: the connection and the lobby are found again from scratch. */
function Retry({ label = "Try again" }: { label?: string }) {
  return (
    <EndActions
      game="royale"
      className={s.actions}
      primary={{ label, onClick: () => window.location.reload() }}
    />
  );
}

function Notice({ title, body, actions }: { title: string; body: string; actions?: React.ReactNode }) {
  return (
    <section className={s.out} role="alert">
      <Head game="royale" eyebrow="The Arena" title={title} />
      <div className={s.body}>
        <p className={s.lede}>{body}</p>
        {actions}
      </div>
    </section>
  );
}

function BotTag({ match, player }: { match: Match; player: string }) {
  return match.state.players.find((p) => p.player === player)?.bot ? <KitBotTag /> : null;
}

/** A player's head and callsign (and bot tag) in a row. */
function Who({ match, player, callsign, me }: { match: Match; player: string; callsign: string; me?: string | null }) {
  const mine = useMyAvatar(player === me ? player : null, callsign);
  return (
    <span className={s.who}>
      {mine ? <AvatarHead cfg={mine} size={30} /> : <PlayerHead address={player} name={callsign} size={30} />}
      <span>
        {callsign}
        <BotTag match={match} player={player} />
      </span>
    </span>
  );
}

/** Your avatar's head beside your callsign. */
function Me({ address, callsign, size = 40 }: { address: string | null; callsign: string; size?: number }) {
  const cfg = useMyAvatar(address, callsign);
  return (
    <span className={s.me}>
      {cfg && <AvatarHead cfg={cfg} size={size} />}
      <span className={s.meName}>{callsign}</span>
    </span>
  );
}

function Join({ match, acct, onJoined }: { match: Match; acct: PrivateKeyAccount | null; onJoined: (c: string) => void }) {
  const { state, source } = match;
  const [callsign, setCallsign] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The callsign is shared with prediction rounds and the island (royale.callsign).
  useEffect(() => {
    try {
      setCallsign((c) => c || (localStorage.getItem(CALLSIGN) ?? ""));
    } catch {
      /* storage blocked */
    }
  }, []);
  const valid = callsign.trim().length >= 1 && callsign.trim().length <= 24;
  const submit = async () => {
    if (!acct || !valid) return;
    setBusy(true);
    setErr(null);
    try {
      localStorage.setItem(CALLSIGN, callsign.trim());
    } catch {
      /* storage blocked */
    }
    try {
      if (source === "mock") {
        onJoined(callsign.trim());
      } else {
        if (state.lobbyId === null) throw new Error("No lobby is open yet. Wait a moment and try again.");
        const r = await join(acct, state.lobbyId, callsign.trim());
        if (!r.ok) throw new Error(String(r.data.error ?? `The engine refused the join (${r.status}).`));
        onJoined(callsign.trim());
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The join did not go through. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={s.out}>
      <Head game="royale" eyebrow={state.lobbyId !== null ? `The Arena · Lobby #${state.lobbyId}` : "The Arena"} title="Trading Royale" />
      <div className={s.body}>
        <p className={s.lede}>
          Everyone starts on <span className={s.fig}>$10,000</span> of play money. The flood rises three times; anyone under the line goes under. The last
          summits split the pot.
        </p>
        <ol className={s.howList}>
          <li><b>1</b>Go long or short on BTC, ETH or SOL with 1x to 100x leverage.</li>
          <li><b>2</b>Three checkpoints cut the bottom quarter and anyone under the flood line.</li>
          <li><b>3</b>Survivors split the pot by profit, paid on chain via Chainlink CRE.</li>
        </ol>
        <p className={s.stat}>
          <Chip className={s.statChip}>
            <b>{state.players.length}</b> in
          </Chip>
          <Chip className={s.statChip}>
            pot <b>${unitsToUsd(state.potUnits)}</b>
          </Chip>
        </p>
        {state.players.length > 0 && (
          <ul className={s.roster}>
            {state.players.slice(0, 12).map((p) => (
              <li key={p.player}>
                <Chip className={s.rosterChip}>
                  <PlayerHead address={p.player} name={p.callsign} size={22} />
                  {p.callsign}
                  {p.bot && <KitBotTag />}
                </Chip>
              </li>
            ))}
          </ul>
        )}
        <label className={s.field}>
          <span>Your callsign</span>
          <span className={s.fieldRow}>
            <JoinHead acct={acct} callsign={callsign} />
            <input
              value={callsign}
              maxLength={24}
              autoComplete="off"
              onChange={(e) => setCallsign(e.target.value)}
              placeholder="Pick a name for the big screen"
            />
          </span>
        </label>
        <Button color="royale" className={s.go} disabled={!valid || busy || !acct} onClick={submit}>
          {busy ? "Joining" : "Join the lobby"}
        </Button>
        {err && <p className={s.error}>{err}</p>}
        <p className={s.fine}>The <span className={s.fig}>$5.00</span> entry is paid for you. Your game key stays in this browser.</p>
        <AppLink className={s.link} href={source === "mock" ? "/play?mock=predict&screen=rounds" : predictRounds()}>
          Or call a price in a prediction round
        </AppLink>
      </div>
    </section>
  );
}

function JoinHead({ acct, callsign }: { acct: PrivateKeyAccount | null; callsign: string }) {
  const cfg = useMyAvatar(acct?.address.toLowerCase() ?? null, callsign);
  return cfg ? <AvatarHead cfg={cfg} size={46} /> : null;
}

function Lobby({ match }: { match: Match }) {
  const { state } = match;
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 250);
    return () => clearInterval(id);
  }, []);
  const t = match.clock();
  return (
    <section className={s.out}>
      <Head game="royale" eyebrow={state.lobbyId !== null ? `The Arena · Lobby #${state.lobbyId}` : "The Arena"} title={state.status === "countdown" ? "Starting in" : "Waiting for players"} />
      <div className={s.body}>
        <p className={s.huge}>{state.status === "countdown" ? clockStr(-t) : state.players.length}</p>
        <p className={s.stat}>
          <Chip className={s.statChip}>
            <b>{state.players.length}</b> players
          </Chip>
          <Chip className={s.statChip}>
            pot <b>${unitsToUsd(state.potUnits)}</b>
          </Chip>
        </p>
        <ul className={s.roster}>
          {state.players.map((p) => (
            <li key={p.player}>
              <Chip className={s.rosterChip}>
                <PlayerHead address={p.player} name={p.callsign} size={26} />
                {p.callsign}
                {p.bot && <KitBotTag />}
              </Chip>
            </li>
          ))}
        </ul>
        {state.status === "open" && state.players.length < 4 && (
          <p className={s.needs}>{figs(`Needs 4 players to start, ${4 - state.players.length} more to go.`)}</p>
        )}
        <GhostButton className={s.actions} href={watchHref(match)}>Watch on the big screen</GhostButton>
      </div>
    </section>
  );
}

function Trade({ match, me, acct }: { match: Match; me: string; acct: PrivateKeyAccount | null }) {
  const { state, source, reducedMotion } = match;
  const [market, setMarket] = useState<Market>(
    () => MARKETS.find((m) => !match.ref.current.positions[me]?.[m]) ?? "BTC",
  );
  const [lev, setLev] = useState(25);
  const [frac, setFrac] = useState(0.25);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 250);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  const rows = state.board?.rows ?? [];
  const alive = rows.filter((r) => r.alive);
  const row = rows.find((r) => r.player === me);
  const equity = num(row?.equity ?? STAGE.startBalance);
  const cutStr = state.board?.cutEquity ?? null;
  const cut = cutStr === null ? START_BALANCE : num(cutStr);
  const zone = num(state.tick?.zone ?? STAGE.zoneStart);
  const marks = state.tick?.marks;
  const positions = state.positions[me] ?? {};
  const used = Object.values(positions).reduce((a, p) => a + num(p!.margin), 0);
  const free = Math.max(0, equity - used);
  const margin = Math.floor(free * frac * 100) / 100;
  const shown = useRolling(equity, reducedMotion);
  const t = match.clock();
  const next = state.tick?.nextCheckpoint;
  const gap = equity - cut;
  const danger = gap < 0;
  const onLine = Math.abs(gap) < 0.005;
  const nextIn = next ? clockStr(next.at - t) : null;

  const sentence = cutStr === null
    ? gap >= 0
      ? `No more cuts. You are $${usd(gap)} above the start, and that profit is your share of the pot.`
      : `No more cuts, but you are $${usd(-gap)} below the start. Finish above it to be paid.`
    : onLine
    ? "You are the last one above the cut line. One bad tick and you go under."
    : danger
      ? `You are $${usd(-gap)} below the cut line.${nextIn ? ` The flood rises in ${nextIn}.` : ""}`
      : `You are $${usd(gap)} above the cut line.`;

  const submit = async (order: Order) => {
    if (busy) return;
    setBusy(true);
    try {
      if (source === "mock") {
        if (acct) await signOrder(acct, state.lobbyId ?? 1, order);
        const mk = order.market;
        const price = marks?.[mk] ?? "0";
        const held = positions[mk];
        const fill: FillEvent =
          order.action === "open"
            ? { type: "fill", t, player: me, market: mk, side: order.side, margin: order.margin, leverage: order.leverage, price, kind: "open" }
            : { type: "fill", t, player: me, market: mk, side: held?.side ?? 1, margin: held?.margin ?? "0", leverage: held?.leverage ?? 1, price, kind: "close" };
        match.inject(fill);
      } else {
        if (!acct) throw new Error("No game key yet. Reload the page.");
        if (state.lobbyId === null) throw new Error("Not connected to a lobby yet.");
        const r = await sendOrder(acct, state.lobbyId, order, state.serverOffsetMs);
        if (!r.ok) throw new Error(String(r.data.error ?? `The engine refused the order (${r.status}).`));
      }
      setToast({
        tone: "ok",
        text: order.action === "open" ? `${order.side === 1 ? "Long" : "Short"} ${order.market} at ${order.leverage}x sent` : `Closed ${order.market}`,
      });
    } catch (e) {
      setToast({ tone: "bad", text: e instanceof Error ? e.message : "The order did not go through." });
    } finally {
      setBusy(false);
    }
  };

  const held = positions[market];
  const pnl = (p: FillEvent) => {
    const mark = num(marks?.[p.market]);
    const entry = num(p.price);
    return entry ? (p.side * num(p.margin) * p.leverage * (mark - entry)) / entry : 0;
  };
  const snap = (v: number) => {
    for (const d of DETENTS) if (Math.abs(v - d) <= 2) return d;
    return v;
  };

  const myCallsign = state.players.find((x) => x.player === me)?.callsign ?? row?.callsign ?? "";
  const levP = `${((lev - 1) / 99) * 100}%`;

  return (
    <section className={s.trade}>
      <Head game="royale" className={s.tradeHead}>
        <div className={s.tradeHeadRow}>
          <span className={s.me}>
            <Me address={me} callsign={myCallsign} size={40} />
          </span>
          <Chip className={s.rank}>
            <b>{ordinal(row?.rank ?? alive.length)}</b> of <b>{alive.length}</b>
          </Chip>
        </div>
        <span className={`${s.tradeHeadRow} ${s.tradeHeadSub}`}>
          <span>
            {next ? (
              <>
                Checkpoint {next.index} in <span className={s.fig}>{nextIn}</span>
              </>
            ) : (
              <>
                Final in <span className={s.fig}>{clockStr(state.duration - t)}</span>
              </>
            )}
          </span>
        </span>
      </Head>

      <div className={s.tradeBody}>
        <div className={s.hero}>
          <div>
            <p className={s.equity}>{usd(shown)}</p>
            <p className={s.sub}>
              <span className={equity >= START_BALANCE ? s.profit : s.loss}>
                {equity >= START_BALANCE ? "+" : "−"}${usd(Math.abs(equity - START_BALANCE))}
              </span>{" "}
              since the start
            </p>
          </div>
          <Gauge equity={equity} cut={cut} zone={zone} />
        </div>
        <p className={`${s.sentence} ${danger ? s.sentenceDanger : onLine ? s.sentenceEdge : ""}`} role="status">
          {figs(sentence)}
        </p>

        <div className={s.markets} role="tablist" aria-label="Market">
          {MARKETS.map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={market === m}
              className={`${s.market} ${market === m ? s.marketOn : ""}`}
              onClick={() => setMarket(m)}
            >
              <span className={s.marketName}>{m}</span>
              <span className={s.fig}>{marks ? usd(num(marks[m])) : "waiting"}</span>
              {positions[m] && (
                <span className={s.marketPos}>
                  <Pennant side={positions[m]!.side} size={14} />
                </span>
              )}
            </button>
          ))}
        </div>

        <div className={s.positions}>
          {Object.values(positions).length === 0 ? (
            <p className={s.empty}>No open positions. Pick a size and a side below.</p>
          ) : (
            Object.values(positions).map((p) => {
              const v = pnl(p!);
              return (
                <div key={p!.market} className={s.pos}>
                  <Pennant side={p!.side} size={18} />
                  <span>
                    {p!.market} {p!.side === 1 ? "long" : "short"} <span className={s.fig}>{p!.leverage}x</span>
                  </span>
                  <span className={v >= 0 ? s.profit : s.loss}>
                    {v >= 0 ? "+" : "−"}${usd(Math.abs(v))}
                  </span>
                  <button className={s.close} disabled={busy} onClick={() => submit({ action: "close", market: p!.market })}>
                    Close
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className={s.ticket}>
          <div className={s.sizes} role="group" aria-label="Size">
            {SIZES.map((z) => (
              <button key={z.label} aria-pressed={frac === z.frac} className={`${s.size} ${frac === z.frac ? s.sizeOn : ""}`} onClick={() => setFrac(z.frac)}>
                {z.label}
              </button>
            ))}
          </div>
          <label className={s.lev}>
            <span className={s.levRow}>
              <span>Leverage</span>
              <span className={`${s.fig} ${s.levVal}`}>{lev}x</span>
            </span>
            <input
              className={s.range}
              style={{ ["--p" as string]: levP, ["--c" as string]: "var(--ink)" }}
              type="range"
              min={1}
              max={100}
              step={1}
              value={lev}
              list="detents"
              onChange={(e) => setLev(snap(Number(e.target.value)))}
            />
            <datalist id="detents">
              {DETENTS.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
            <span className={s.detents} aria-hidden>
              {DETENTS.map((d) => (
                <span key={d} style={{ left: `${((d - 1) / 99) * 100}%` }}>
                  {d}
                </span>
              ))}
            </span>
          </label>
          <p className={s.summary}>
            <span className={s.fig}>${usd(margin)}</span> margin moves <span className={s.fig}>${usd(margin * lev, 0)}</span> of {market}
          </p>
          {held ? (
            <GhostButton className={s.side} disabled={busy} onClick={() => submit({ action: "close", market })}>
              Close {market} {held.side === 1 ? "long" : "short"}
            </GhostButton>
          ) : (
            <div className={s.sides}>
              <Button
                big
                color={MEANING.long.fill}
                className={s.side}
                disabled={busy || margin < 0.01}
                onClick={() => submit({ action: "open", market, side: 1, margin: margin.toFixed(2), leverage: lev })}
              >
                <Pennant side={1} size={22} plain />
                Long
              </Button>
              <Button
                big
                color={MEANING.short.fill}
                className={s.side}
                disabled={busy || margin < 0.01}
                onClick={() => submit({ action: "open", market, side: -1, margin: margin.toFixed(2), leverage: lev })}
              >
                Short
                <Pennant side={-1} size={22} plain />
              </Button>
            </div>
          )}
        </div>
      </div>
      {toast && <p className={`${s.toast} ${toast.tone === "bad" ? s.toastBad : ""}`}>{figs(toast.text)}</p>}
    </section>
  );
}

const REASON: Record<string, string> = {
  cut: "You were in the bottom quarter when the flood rose.",
  zone: "You were under the flood line when it rose.",
  liquidated: "Your equity hit zero and every position closed.",
};

function Eliminated({
  match,
  me,
  elim,
}: {
  match: Match;
  me: string;
  elim: { ev: EliminatedEvent; p: EliminatedEvent["players"][number] };
}) {
  const { state } = match;
  const row = state.board?.rows.find((r) => r.player === me);
  const alive = state.board?.rows.filter((r) => r.alive) ?? [];
  const total = state.players.length;
  const finalists = state.final?.finalists;
  const myCallsign = state.players.find((p) => p.player === me)?.callsign ?? "";
  return (
    <section className={s.out}>
      <div className={s.flood} aria-hidden>
        <span className={s.drowned}>
          <PlayerHeadOrMine address={me} callsign={myCallsign} />
          <Chip className={s.drownedName}>{myCallsign}</Chip>
        </span>
      </div>
      <Head
        game="royale"
        eyebrow={elim.ev.checkpoint ? `Checkpoint ${elim.ev.checkpoint}` : elim.p.reason === "liquidated" ? "Liquidated" : "Out of the match"}
        title="You went under"
      />
      <div className={s.outBody}>
        <NextChip match={match} />
        <p className={s.lede}>{REASON[elim.p.reason]}</p>
        <dl className={s.facts}>
          <div>
            <dt>Finished</dt>
            <dd className={s.fig}>
              {ordinal(elim.p.rank)} of {total}
            </dd>
          </div>
          <div>
            <dt>Last equity</dt>
            <dd>
              <span className={num(row?.equity) >= START_BALANCE ? s.profit : s.loss}>{usd(num(row?.equity))}</span>
            </dd>
          </div>
        </dl>
        <p className={s.watch}>
          {figs(finalists ? `${finalists.length} made it to the end.` : `${alive.length} still standing.`)}
        </p>
        <ul className={s.standing}>
          {(finalists
            ? finalists.map((f) => ({ player: f.player, callsign: f.callsign, equity: f.equity }))
            : alive.slice(0, 6)
          ).map((r) => (
            <li key={r.player}>
              <Who match={match} player={r.player} callsign={r.callsign} />
              <span className={s.fig}>{usd(num(r.equity))}</span>
            </li>
          ))}
        </ul>
        <RoyaleActions
          match={match}
          primary={finalists ? undefined : { label: "Watch the rest on the big screen", href: watchHref(match) }}
          watch={!!finalists}
        />
      </div>
    </section>
  );
}

function PlayerHeadOrMine({ address, callsign }: { address: string; callsign: string }) {
  const cfg = useMyAvatar(address, callsign);
  return cfg ? <AvatarHead cfg={cfg} size={44} /> : null;
}

function Result({ match, me }: { match: Match; me: string | null }) {
  const { state } = match;
  // before `final`: the survivors at the last live marks, priced with the shared settle()
  const early = state.final ? null : provisionalFinal(state);
  const fin = state.final ?? early;
  const settled = state.settled;
  const mine = fin?.finalists.find((f) => f.player === me);
  const paid = (p: string) => {
    if (!settled) return null;
    const i = settled.winners.indexOf(p);
    return i >= 0 ? settled.amounts[i] : "0";
  };
  const myUnits = mine ? (paid(mine.player) ?? mine.provisionalPayoutUnits) : null;
  // finalists arrive sorted by address; rank them by final equity for the headline and the list
  const ranked = fin ? [...fin.finalists].sort((a, b) => num(b.equity) - num(a.equity)) : [];
  const place = mine ? ranked.indexOf(mine) + 1 : 0;
  if (!fin)
    return <Notice title="The flood has stopped" body="Counting the summits and fetching the final prices." actions={<LoadBar label="Building the final book" />} />;
  const out = (match.state.board?.rows ?? []).filter((r) => !r.alive).sort((a, b) => a.rank - b.rank);
  return (
    <section className={s.out}>
      <Head
        game="royale"
        eyebrow={mine ? `${ordinal(place)} of ${fin.finalists.length} finalists` : "Final"}
        title={mine ? (place === 1 ? "You hold the high ground" : "You made it to the end") : `${ranked[0]?.callsign} holds the high ground`}
      >
        {mine && (
          <div className={s.headMe}>
            <Me address={me} callsign={mine.callsign} size={36} />
          </div>
        )}
      </Head>
      <div className={s.body}>
        <NextChip match={match} />
        {mine && (
          <>
            <p className={s.payout}>${unitsToUsd(myUnits ?? "0")}</p>
            <p className={s.sub}>
              {settled ? (isTxHash(settled.txHash) ? "Paid to your address" : "Settled offline (no chain), nothing paid") : early ? "Provisional · live prices" : "Provisional, until the settlement report lands"} from an equity of{" "}
              <span className={s.fig}>{usd(num(mine.equity))}</span>
            </p>
          </>
        )}
        <ul className={`${s.standing} ${s.resultList}`}>
          {ranked.map((f) => (
            <li key={f.player} className={f.player === me ? s.meRow : ""}>
              <Who match={match} player={f.player} callsign={f.callsign} me={me} />
              <span className={s.fig}>${unitsToUsd(paid(f.player) ?? f.provisionalPayoutUnits)}</span>
            </li>
          ))}
        </ul>
        {out.length > 0 && (
          <>
            <p className={s.outHead}>Went under</p>
            <ul className={`${s.standing} ${s.outList}`}>
              {out.map((r) => (
                <li key={r.player} className={r.player === me ? s.meRow : ""}>
                  <Who match={match} player={r.player} callsign={r.callsign} me={me} />
                  <span className={s.fig}>#{r.rank} · {usd(num(r.equity))}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {settled ? (
          isTxHash(settled.txHash) ? (
            <div className={s.stamp}>
              <p className={s.stampTitle}>Verified by Chainlink</p>
              <p className={s.stampBody}>
                Settled on chain, tx <span className={s.fig}>{short(settled.txHash)}</span>
              </p>
              <p className={s.stampBody}>{settled.mode === "deployed" ? "Paid on chain from the CRE workflow report" : "Paid on chain from the CRE workflow, run locally"}</p>
            </div>
          ) : (
            <div className={s.stamp}>
              <p className={`${s.stampTitle} ${s.stampOff}`}>Settled offline (no chain)</p>
              <p className={s.stampBody}>This engine runs without a chain, so nothing was paid on chain.</p>
            </div>
          )
        ) : early ? (
          <WaitingClose />
        ) : (
          <Settling />
        )}
        <RoyaleActions match={match} />
      </div>
    </section>
  );
}

function Spectate({ match }: { match: Match }) {
  const alive = match.state.board?.rows.filter((r) => r.alive) ?? [];
  return (
    <section className={s.out}>
      <Head game="royale" eyebrow="The Arena" title="The match has started" />
      <div className={s.body}>
        <p className={s.lede}>This lobby is closed to new players. <span className={s.fig}>{alive.length}</span> still standing.</p>
        <RoyaleActions match={match} primary={{ label: "Watch live", href: watchHref(match) }} watch={false} />
      </div>
    </section>
  );
}
