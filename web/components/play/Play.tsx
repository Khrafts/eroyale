"use client";
// The phone: join, lobby, trade, eliminated, result, as states of one screen.
// Same world as the storm arena: survey-night sky, flood blue owns the zone, mint long, orchid short.
import { useEffect, useMemo, useRef, useState } from "react";
import type { PrivateKeyAccount } from "viem/accounts";
import { condensed, extra } from "@/components/arena/b/fonts";
import { MARKETS, START_BALANCE, STAGE, isTxHash, num, unitsToUsd } from "@/lib/events";
import type { EliminatedEvent, FillEvent, Market, Side } from "@/lib/events";
import { burner, join, sendOrder, signOrder, type Order } from "@/lib/engine";
import { useMatch, type Match } from "@/lib/useMatch";
import { useRolling } from "@/lib/useRolling";
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

function Pennant({ side, size = 22 }: { side: Side; size?: number }) {
  // A wind pennant: long flies right in mint, short flies left in orchid.
  const w = size * 1.4;
  return (
    <svg width={w} height={size} viewBox="0 0 28 20" aria-hidden className={side === 1 ? s.long : s.short}>
      {side === 1 ? (
        <>
          <rect x="1" y="0" width="2.5" height="20" fill="currentColor" />
          <path d="M3.5 1 L27 6.5 L3.5 12 Z" fill="currentColor" />
        </>
      ) : (
        <>
          <rect x="24.5" y="0" width="2.5" height="20" fill="currentColor" />
          <path d="M24.5 1 L1 6.5 L24.5 12 Z" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/** Small altitude gauge: the flood, the cut line, and you. */
function Gauge({ equity, cut, zone }: { equity: number; cut: number; zone: number }) {
  const lo = Math.min(equity, cut, zone) - 250;
  const hi = Math.max(equity, cut, zone) + 250;
  const y = (v: number) => 150 - ((v - lo) / (hi - lo)) * 140 - 5;
  const below = equity < cut;
  return (
    <svg className={s.gauge} viewBox="0 0 64 150" role="img" aria-label="Your altitude against the cut line and the flood">
      <rect x="0" y={y(zone)} width="64" height={150 - y(zone)} className={s.gaugeFlood} />
      <line x1="0" x2="64" y1={y(cut)} y2={y(cut)} className={s.gaugeCut} />
      <path
        d={`M14 ${y(equity) + 13} L32 ${y(equity) - 9} L50 ${y(equity) + 13} Z`}
        className={below ? s.gaugeMeLow : s.gaugeMe}
      />
    </svg>
  );
}

type Toast = { text: string; tone: "ok" | "bad" } | null;

/** Royale or prediction mode, from ?mode=predict or ?mock=predict (read after mount: the page is prerendered). */
export default function Play() {
  const [mode, setMode] = useState<"royale" | "predict" | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setMode(q.get("mock") === "predict" || q.get("mode") === "predict" ? "predict" : "royale");
  }, []);
  if (mode === "predict") return <PredictPhone />;
  if (mode === "royale") return <RoyalePhone />;
  return <main className={s.root} />;
}

function RoyalePhone() {
  const match = useMatch();
  const { state, source } = match;
  const [acct, setAcct] = useState<PrivateKeyAccount | null>(null);
  const [joinedAs, setJoinedAs] = useState<string | null>(null);
  useEffect(() => setAcct(burner()), []);

  const me = source === "mock" ? match.me : (acct?.address.toLowerCase() ?? null);
  const inLobby = !!me && state.players.some((p) => p.player === me);

  return (
    <main className={`${s.root} ${condensed.className}`} style={{ ["--fig" as string]: extra.style.fontFamily }}>
      <Body match={match} me={me} inLobby={inLobby || !!joinedAs} acct={acct} onJoined={setJoinedAs} />
    </main>
  );
}

function Body({
  match,
  me,
  inLobby,
  acct,
  onJoined,
}: {
  match: Match;
  me: string | null;
  inLobby: boolean;
  acct: PrivateKeyAccount | null;
  onJoined: (c: string) => void;
}) {
  const { state } = match;
  const myElim = useMemo(() => {
    for (const e of state.eliminations) {
      const p = e.players.find((x) => x.player === me);
      if (p) return { ev: e, p };
    }
    return null;
  }, [state.eliminations, me]);

  if (state.error) return <Notice title="Not connected" body={state.error} />;
  if (!state.status) return <p className={s.waiting}>Finding the lobby</p>;
  if (state.status === "cancelled")
    return (
      <Notice
        title="This match was called off"
        body="Not enough players made it in. Every entry is refunded on chain. Keep this page open; the next lobby shows up here."
      />
    );
  if (state.final || state.status === "settling" || state.status === "settled") {
    if (myElim) return <Eliminated match={match} me={me!} elim={myElim} />;
    return <Result match={match} me={me} />;
  }
  if (!inLobby && (state.status === "open" || state.status === "countdown"))
    return <Join match={match} acct={acct} onJoined={onJoined} />;
  if (state.status === "open" || state.status === "countdown") return <Lobby match={match} />;
  if (myElim) return <Eliminated match={match} me={me!} elim={myElim} />;
  if (!inLobby) return <Spectate match={match} />;
  return <Trade match={match} me={me!} acct={acct} />;
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <section className={s.out} role="alert">
      <h1 className={s.outTitle}>{title}</h1>
      <p className={s.lede}>{body}</p>
    </section>
  );
}

function BotTag({ match, player }: { match: Match; player: string }) {
  return match.state.players.find((p) => p.player === player)?.bot ? <span className={s.bot}>BOT</span> : null;
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
    <section className={s.join}>
      <h1 className={s.title}>Trading Royale</h1>
      <p className={s.lede}>
        Everyone starts on $10,000 of play money. The flood rises three times; anyone under the line goes under. The last
        summits split the pot.
      </p>
      <p className={s.stat}>
        <span className={s.fig}>{state.players.length}</span> in, pot <span className={s.fig}>${unitsToUsd(state.potUnits)}</span>
      </p>
      <label className={s.field}>
        <span>Your callsign</span>
        <input
          value={callsign}
          maxLength={24}
          autoComplete="off"
          onChange={(e) => setCallsign(e.target.value)}
          placeholder="Pick a name for the big screen"
        />
      </label>
      <button className={s.primary} disabled={!valid || busy || !acct} onClick={submit}>
        {busy ? "Joining" : "Join the lobby"}
      </button>
      {err && <p className={s.error}>{err}</p>}
      <p className={s.fine}>The $5.00 entry is paid for you. Your game key stays in this browser.</p>
      <a className={s.fine} href={source === "mock" ? "?mock=predict&screen=rounds" : "?mode=predict&screen=rounds"}>
        Or call a price in a prediction round
      </a>
    </section>
  );
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
    <section className={s.lobby}>
      <p className={s.kicker}>{state.status === "countdown" ? "Starting in" : "Waiting for players"}</p>
      <p className={s.huge}>{state.status === "countdown" ? clockStr(-t) : state.players.length}</p>
      <p className={s.stat}>
        <span className={s.fig}>{state.players.length}</span> players, pot{" "}
        <span className={s.fig}>${unitsToUsd(state.potUnits)}</span>
      </p>
      <ul className={s.roster}>
        {state.players.map((p) => (
          <li key={p.player}>
            {p.callsign}
            {p.bot && <span className={s.bot}>BOT</span>}
          </li>
        ))}
      </ul>
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

  return (
    <section className={s.trade}>
      <header className={s.top}>
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
        <span>
          <span className={s.fig}>{ordinal(row?.rank ?? alive.length)}</span> of <span className={s.fig}>{alive.length}</span>
        </span>
      </header>

      <div className={s.hero}>
        <div>
          <p className={`${s.equity} ${equity >= START_BALANCE ? s.profit : s.loss}`}>{usd(shown)}</p>
          <p className={s.sub}>
            {equity >= START_BALANCE ? "+" : "−"}${usd(Math.abs(equity - START_BALANCE))} since the start
          </p>
        </div>
        <Gauge equity={equity} cut={cut} zone={zone} />
      </div>
      <p className={`${s.sentence} ${danger ? s.sentenceDanger : onLine ? s.sentenceEdge : ""}`} role="status">
        {sentence}
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
                <Pennant side={positions[m]!.side} size={16} />
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
                <Pennant side={p!.side} size={20} />
                <span>
                  {p!.market} {p!.side === 1 ? "long" : "short"} <span className={s.fig}>{p!.leverage}x</span>
                </span>
                <span className={`${s.fig} ${v >= 0 ? s.profit : s.loss}`}>
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
        <div className={s.sizes}>
          {SIZES.map((z) => (
            <button key={z.label} className={`${s.size} ${frac === z.frac ? s.sizeOn : ""}`} onClick={() => setFrac(z.frac)}>
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
          <button className={s.closeBig} disabled={busy} onClick={() => submit({ action: "close", market })}>
            Close {market} {held.side === 1 ? "long" : "short"}
          </button>
        ) : (
          <div className={s.sides}>
            <button
              className={s.goLong}
              disabled={busy || margin < 0.01}
              onClick={() => submit({ action: "open", market, side: 1, margin: margin.toFixed(2), leverage: lev })}
            >
              <Pennant side={1} size={26} />
              Long
            </button>
            <button
              className={s.goShort}
              disabled={busy || margin < 0.01}
              onClick={() => submit({ action: "open", market, side: -1, margin: margin.toFixed(2), leverage: lev })}
            >
              Short
              <Pennant side={-1} size={26} />
            </button>
          </div>
        )}
      </div>
      {toast && <p className={`${s.toast} ${toast.tone === "bad" ? s.toastBad : ""}`}>{toast.text}</p>}
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
  return (
    <section className={s.out}>
      <div className={s.flood} aria-hidden>
        <svg className={s.drowned} viewBox="0 0 200 90" preserveAspectRatio="none">
          <path d="M0 90 L40 70 L70 30 L88 44 L110 12 L140 60 L170 72 L200 90 Z" />
        </svg>
        <span className={s.drownedName}>{state.players.find((p) => p.player === me)?.callsign}</span>
      </div>
      <p className={s.kicker}>
        {elim.ev.checkpoint ? `Checkpoint ${elim.ev.checkpoint}` : elim.p.reason === "liquidated" ? "Liquidated" : "Out of the match"}
      </p>
      <h1 className={s.outTitle}>You went under</h1>
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
          <dd className={`${s.fig} ${num(row?.equity) >= START_BALANCE ? s.profit : s.loss}`}>{usd(num(row?.equity))}</dd>
        </div>
      </dl>
      <p className={s.watch}>
        {finalists ? `${finalists.length} made it to the end.` : `${alive.length} still standing. Watch the big screen.`}
      </p>
      <ul className={s.standing}>
        {(finalists
          ? finalists.map((f) => ({ player: f.player, callsign: f.callsign, equity: f.equity }))
          : alive.slice(0, 6)
        ).map((r) => (
          <li key={r.player}>
            <span>
              {r.callsign}
              <BotTag match={match} player={r.player} />
            </span>
            <span className={s.fig}>{usd(num(r.equity))}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Result({ match, me }: { match: Match; me: string | null }) {
  const { state } = match;
  const fin = state.final;
  const settled = state.settled;
  const mine = fin?.finalists.find((f) => f.player === me);
  const paid = (p: string) => {
    if (!settled) return null;
    const i = settled.winners.indexOf(p);
    return i >= 0 ? settled.amounts[i] : "0";
  };
  const myUnits = mine ? (paid(mine.player) ?? mine.provisionalPayoutUnits) : null;
  const place = mine && fin ? fin.finalists.indexOf(mine) + 1 : 0;
  if (!fin) return <p className={s.waiting}>The flood has stopped. Counting the summits.</p>;
  return (
    <section className={s.result}>
      <p className={s.kicker}>{mine ? `${ordinal(place)} of ${fin.finalists.length} finalists` : "Final"}</p>
      <h1 className={s.title}>{mine ? (place === 1 ? "You hold the high ground" : "You made it to the end") : `${fin.finalists[0]?.callsign} holds the high ground`}</h1>
      {mine && (
        <>
          <p className={`${s.payout} ${s.profit}`}>${unitsToUsd(myUnits ?? "0")}</p>
          <p className={s.sub}>
            {settled ? (isTxHash(settled.txHash) ? "Paid to your address" : "Settled offline (no chain), nothing paid") : "Provisional, until the settlement report lands"} from an equity of{" "}
            <span className={s.fig}>{usd(num(mine.equity))}</span>
          </p>
        </>
      )}
      <ul className={s.standing}>
        {fin.finalists.map((f) => (
          <li key={f.player} className={f.player === me ? s.meRow : ""}>
            <span>
              {f.callsign}
              <BotTag match={match} player={f.player} />
            </span>
            <span className={s.fig}>${unitsToUsd(paid(f.player) ?? f.provisionalPayoutUnits)}</span>
          </li>
        ))}
      </ul>
      {settled ? (
        isTxHash(settled.txHash) ? (
          <div className={s.stamp}>
            <p className={s.stampTitle}>Verified by Chainlink</p>
            <p className={s.stampBody}>
              Settled on chain, tx <span className={s.fig}>{short(settled.txHash)}</span>
            </p>
            <p className={s.stampBody}>{settled.mode === "deployed" ? "Paid by the CRE workflow report" : "Paid from a simulated CRE report"}</p>
          </div>
        ) : (
          <div className={s.stamp}>
            <p className={s.stampTitle}>Settled offline (no chain)</p>
            <p className={s.stampBody}>This engine runs without a chain, so nothing was paid on chain.</p>
          </div>
        )
      ) : (
        <p className={s.fine}>Payouts are provisional until the Chainlink report settles the pot.</p>
      )}
    </section>
  );
}

function Spectate({ match }: { match: Match }) {
  const alive = match.state.board?.rows.filter((r) => r.alive) ?? [];
  return (
    <section className={s.out}>
      <h1 className={s.outTitle}>The match has started</h1>
      <p className={s.lede}>This lobby is closed to new players. {alive.length} still standing.</p>
    </section>
  );
}
