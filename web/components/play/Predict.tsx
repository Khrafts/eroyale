"use client";
// The phone in prediction mode: rounds list, create a round, predict, locked, result, as states of /play?mode=predict.
// Same world as the storm: flood blue is only the storm (the losing water), gold is the winners, chalk the live price.
import { useEffect, useMemo, useRef, useState } from "react";
import type { PrivateKeyAccount } from "viem/accounts";
import { condensed, extra } from "@/components/arena/b/fonts";
import { MARKETS, unitsToUsd } from "@/lib/events";
import type { RoundInfo } from "@/lib/events";
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
  useRounds,
  winnersOf,
  type Draft,
  type RangeKey,
} from "@/lib/predict";
import { PROTOCOL_LOBBY, mockMine } from "@/mocks/predict";
import s from "./play.module.css";
import p from "./predict.module.css";

type View = { kind: "rounds" } | { kind: "create" } | { kind: "round"; lobby: number };

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

export default function PredictPhone() {
  const [view, setView] = useState<View | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const screen = q.get("screen");
    const lobby = Number(q.get("lobby")) || null;
    if (screen === "create") setView({ kind: "create" });
    else if (screen === "rounds") setView({ kind: "rounds" });
    else if (lobby) setView({ kind: "round", lobby });
    else if (q.get("mock") === "predict") setView({ kind: "round", lobby: PROTOCOL_LOBBY });
    else setView({ kind: "rounds" });
  }, []);
  const go = (v: View) => {
    setView(v);
    const q = new URLSearchParams(window.location.search);
    q.delete("screen");
    q.delete("lobby");
    if (v.kind === "round") q.set("lobby", String(v.lobby));
    else q.set("screen", v.kind);
    if (!q.get("mock")) q.set("mode", "predict");
    window.history.replaceState(null, "", `${window.location.pathname}?${q}`);
    window.scrollTo(0, 0);
  };
  return (
    <main className={`${s.root} ${condensed.className}`} style={{ ["--fig" as string]: extra.style.fontFamily }}>
      {view && <Screens view={view} go={go} />}
    </main>
  );
}

function Screens({ view, go }: { view: View; go: (v: View) => void }) {
  const match = useMatch({ predict: true, lobby: view.kind === "round" ? view.lobby : null });
  const [acct, setAcct] = useState<PrivateKeyAccount | null>(null);
  useEffect(() => setAcct(burner()), []);
  const me = match.source === "mock" ? match.me : (acct?.address.toLowerCase() ?? null);
  if (view.kind === "rounds") return <Rounds match={match} go={go} />;
  if (view.kind === "create") return <Create match={match} acct={acct} go={go} />;
  return <Round match={match} me={me} acct={acct} go={go} />;
}

// ---------- rounds list ----------
function Rounds({ match, go }: { match: Match; go: (v: View) => void }) {
  useTick();
  const { rounds, error, loaded } = useRounds(match);
  const now = match.clock();
  const proto = rounds.find((r) => r.protocol);
  const users = rounds.filter((r) => !r.protocol);
  const royale = match.source === "mock" ? "?mock=1" : "?";
  return (
    <section className={p.page}>
      <h1 className={s.title}>Call the price</h1>
      <p className={s.lede}>Say where the price will be when the round resolves. The closest calls split the pot.</p>
      {error && <p className={s.error}>{error}</p>}
      {!loaded && <p className={s.fine}>Finding open rounds</p>}
      {proto && (
        <button className={p.proto} onClick={() => go({ kind: "round", lobby: proto.lobbyId })}>
          <span className={p.protoTop}>
            <span>
              <span className={p.protoMarket}>{proto.params.market}</span>
              <span className={`${s.fig} ${p.protoMark}`}>{proto.mark ? commas(proto.mark) : "waiting"}</span>
            </span>
            <span className={p.protoClock}>
              <span className={p.small}>Locks in</span>
              <span className={`${s.fig} ${p.protoCount}`}>{countdown(proto.lockTime - now)}</span>
            </span>
          </span>
          <span className={p.protoFacts}>
            <span className={s.fig}>{proto.players}</span> in, pot <span className={s.fig}>${unitsToUsd(proto.potUnits)}</span>. Closest{" "}
            {winnersOf(Math.max(proto.players, 4), proto.params.winnerBps)} split it by rank, resolves{" "}
            {durationStr(proto.endTime - proto.lockTime)} after the lock.
          </span>
          <span className={p.protoCta}>Join for ${unitsToUsd(proto.params.entryUnits)}</span>
        </button>
      )}
      <h2 className={p.h2}>Rounds players made</h2>
      {users.length === 0 ? (
        <p className={s.empty}>None open right now. Make one below.</p>
      ) : (
        <ul className={p.list}>
          {users.map((r) => (
            <li key={r.lobbyId}>
              <UserRound r={r} now={now} onOpen={() => go({ kind: "round", lobby: r.lobbyId })} />
            </li>
          ))}
        </ul>
      )}
      <button className={p.secondary} onClick={() => go({ kind: "create" })}>
        Create a round
      </button>
      <a className={p.link} href={`/play${royale}`}>
        Play Trading Royale instead
      </a>
    </section>
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
          Top {r.params.winnerBps / 100}% win, {r.params.split} split
          {r.params.creator ? `, ${fee ? `${fee / 100}% to ` : "made by "}${shortAddr(r.params.creator)}` : ""}
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

function Create({ match, acct, go }: { match: Match; acct: PrivateKeyAccount | null; go: (v: View) => void }) {
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
        ? String(v)
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
        if (id) go({ kind: "round", lobby: id });
      }
    } catch (e) {
      setMsg({ tone: "bad", text: e instanceof Error ? e.message : "The round was not created." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={p.create}>
      <div className={p.preview} aria-live="polite">
        <div className={p.previewHead}>
          <button className={p.back} onClick={() => go({ kind: "rounds" })}>
            Rounds
          </button>
          <h1 className={p.createTitle}>Create a round</h1>
        </div>
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
                  ranks {7} to {pv.byRank.length - 1}
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
        <button className={s.primary} disabled={busy || !acct || !!pv.error} onClick={submit}>
          {busy ? "Creating the round" : "Create round"}
        </button>
        {msg && <p className={msg.tone === "bad" ? s.error : s.fine}>{msg.text}</p>}
        <p className={s.fine}>The protocol keeps 5% of every pot. You do not have to play your own round.</p>
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
      <input type="range" min={r.min} max={r.max} step={r.step} value={value} onChange={(e) => set(k, Number(e.target.value))} />
    </label>
  );
}

// ---------- one round: join, predict, locked, result ----------
function Round({ match, me, acct, go }: { match: Match; me: string | null; acct: PrivateKeyAccount | null; go: (v: View) => void }) {
  const st = match.state;
  if (st.error) return <Notice title="Not connected" body={st.error} go={go} />;
  if (!st.round) return <p className={s.waiting}>Finding the round</p>;
  if (st.cancelled || st.status === "cancelled")
    return <Notice title="This round was called off" body="Fewer than four players joined before the lock. Every entry is refunded on chain." go={go} />;
  const joined = !!me && st.players.some((x) => x.player === me);
  if (st.pfinal) return <Result match={match} me={me} go={go} />;
  if (st.locked) return <Locked match={match} me={me} go={go} />;
  if (!joined) return <JoinRound match={match} acct={acct} me={me} go={go} />;
  return <Call match={match} me={me!} acct={acct} go={go} />;
}

function Notice({ title, body, go }: { title: string; body: string; go: (v: View) => void }) {
  return (
    <section className={p.page} role="alert">
      <h1 className={s.title}>{title}</h1>
      <p className={s.lede}>{body}</p>
      <button className={s.primary} onClick={() => go({ kind: "rounds" })}>
        See open rounds
      </button>
    </section>
  );
}

function RoundBar({ match, go, right }: { match: Match; go: (v: View) => void; right: React.ReactNode }) {
  const r = match.state.round!;
  return (
    <header className={p.bar1}>
      <button className={p.back} onClick={() => go({ kind: "rounds" })}>
        Rounds
      </button>
      <span className={p.barTitle}>
        {r.params.market} round {r.lobbyId}
      </span>
      <span className={p.barRight}>{right}</span>
    </header>
  );
}

const liveMark = (match: Match): bigint | null => {
  const st = match.state;
  const last = st.ptick?.mark ?? (st.path.length ? st.path[st.path.length - 1].p.toFixed(2) : null);
  return centsOf(last);
};

function JoinRound({ match, acct, me, go }: { match: Match; acct: PrivateKeyAccount | null; me: string | null; go: (v: View) => void }) {
  useTick();
  const st = match.state;
  const r = st.round!;
  const [callsign, setCallsign] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setCallsign(readStore(CALLSIGN) ?? ""), []);
  const valid = callsign.trim().length >= 1 && callsign.trim().length <= 24;
  const left = r.lockTime - match.clock();
  const mark = liveMark(match);
  const submit = async () => {
    if (!acct || !valid || busy) return;
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
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The join did not go through. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={p.page}>
      <RoundBar match={match} go={go} right={<>Locks in <span className={s.fig}>{countdown(left)}</span></>} />
      <p className={s.kicker}>{r.params.market} now</p>
      <p className={`${s.fig} ${p.live}`}>{mark !== null ? fmt(mark) : "waiting"}</p>
      <p className={s.lede}>
        <span className={s.fig}>{st.players.length}</span> in, pot <span className={s.fig}>${unitsToUsd(st.potUnits)}</span>. The closest{" "}
        {r.params.winnerBps / 100}% of players split it {r.params.split === "equal" ? "evenly" : r.params.split === "steep" ? "steeply by rank" : "by rank"}, after
        a 5% protocol fee{r.params.creator && r.params.creatorFeeBps ? ` and a ${r.params.creatorFeeBps / 100}% creator fee` : ""}.
      </p>
      <label className={s.field}>
        <span>Your callsign</span>
        <input value={callsign} maxLength={24} autoComplete="off" onChange={(e) => setCallsign(e.target.value)} placeholder="A name for the big screen" />
      </label>
      <button className={s.primary} disabled={!valid || busy || !acct || left <= 0} onClick={submit}>
        {busy ? "Joining" : `Join for $${unitsToUsd(r.params.entryUnits)}`}
      </button>
      {err && <p className={s.error}>{err}</p>}
      <p className={s.fine}>The entry is paid for you. Your game key stays in this browser.</p>
    </section>
  );
}

/** The predict screen: live price, your call, a tape to drag and buttons to nudge it, the lock countdown. */
function Call({ match, me, acct, go }: { match: Match; me: string; acct: PrivateKeyAccount | null; go: (v: View) => void }) {
  useTick();
  const st = match.state;
  const r = st.round!;
  const market = r.params.market;
  const mark = liveMark(match);
  const storeKey = `${SENT}.${r.lobbyId}.${me}`;
  const [draft, setDraft] = useState<bigint | null>(null);
  const [sent, setSent] = useState<string | null>(null);
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
      <RoundBar match={match} go={go} right={<>Locks in <span className={`${s.fig} ${left <= 10 ? p.urgent : ""}`}>{countdown(left)}</span></>} />
      <div className={p.callTop}>
        <p className={s.kicker}>{market} now</p>
        <p className={`${s.fig} ${p.live}`}>{mark !== null ? fmt(mark) : "waiting"}</p>
      </div>
      <div className={p.mine}>
        <p className={s.kicker}>{sent ? (changed ? "Your new call, not sent" : "Your call") : "Your call, not sent yet"}</p>
        <p className={`${s.fig} ${p.callFig}`}>{price !== null ? commas(price) : "—"}</p>
        <p className={p.diff}>{sentence}</p>
      </div>
      <p className={p.count}>
        <span className={s.fig}>{st.predictedCount}</span> of <span className={s.fig}>{st.players.length}</span> have called. Calls stay sealed until the lock.
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
          <button className={s.primary} disabled={busy || !acct || left <= 0 || price === null} onClick={submit}>
            {busy ? "Sending" : sent ? `Move my call to ${commas(price!)}` : `Call ${price !== null ? commas(price) : ""}`}
          </button>
        )}
      </div>
      {msg && <p className={`${s.toast} ${msg.tone === "bad" ? s.toastBad : ""}`}>{msg.text}</p>}
    </section>
  );
}

/** The price since the round opened, with your call as a line: where it has been against where you say it goes. */
function Sketch({ match, call }: { match: Match; call: bigint | null }) {
  const st = match.state;
  const r = st.round!;
  const W = 358;
  const H = 150;
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
function Locked({ match, me, go }: { match: Match; me: string | null; go: (v: View) => void }) {
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
    <section className={p.page}>
      <RoundBar match={match} go={go} right={resolving ? "Reading the price" : <>Resolves in <span className={s.fig}>{countdown(left)}</span></>} />
      <p className={s.kicker}>{r.params.market} now</p>
      <p className={`${s.fig} ${p.live}`}>{mark !== null ? fmt(mark) : "waiting"}</p>
      <p className={`${s.sentence} ${mine && !inside ? s.sentenceDanger : ""}`} role="status">
        {sentence}
      </p>
      <Strip match={match} me={me} />
      <h2 className={p.h2}>Winning now</h2>
      <ol className={p.leaders}>
        {ranked.slice(0, k).map((x, i) => (
          <li key={x.player} className={x.player === me ? s.meRow : ""}>
            <span className={s.fig}>{i + 1}</span>
            <span>
              {x.callsign}
              {x.bot && <span className={s.bot}>BOT</span>}
            </span>
            <span className={s.fig}>{commas(x.price)}</span>
            <span className={`${s.fig} ${p.dist}`}>{money(x.d)}</span>
          </li>
        ))}
      </ol>
    </section>
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
            You {commas(my.price)}
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

function Result({ match, me, go }: { match: Match; me: string | null; go: (v: View) => void }) {
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
    <section className={p.page}>
      <RoundBar match={match} go={go} right={settled ? "Settled" : "Resolved"} />
      <p className={s.kicker}>{r.params.market} settled at</p>
      <p className={`${s.fig} ${p.settle}`}>{commas(fin.settlementPrice)}</p>
      {win ? (
        <>
          <h1 className={s.title}>{win.rank === 1 ? "Closest call in the round" : `${ordinal(win.rank)} closest. You win.`}</h1>
          <p className={`${s.payout} ${s.profit}`}>${unitsToUsd(units ?? "0")}</p>
          <p className={s.sub}>
            {settled ? "Paid to your address" : "Provisional, until the settlement report lands"}. You called{" "}
            <span className={s.fig}>{commas(win.price)}</span>, off by <span className={s.fig}>{commas(win.distance)}</span>.
          </p>
        </>
      ) : mine && myC !== null ? (
        <>
          <h1 className={s.title}>Not close enough this time</h1>
          <p className={s.sub}>
            You called <span className={s.fig}>{commas(mine.price)}</span>, off by <span className={s.fig}>{money(myC - sp)}</span>. The last winning call was off by{" "}
            <span className={s.fig}>{commas(winners[winners.length - 1]?.distance ?? "0.00")}</span>.
          </p>
        </>
      ) : (
        <h1 className={s.title}>{winners[0] ? `${winners[0].callsign} called it closest` : "Nobody made a call"}</h1>
      )}
      <ol className={p.leaders}>
        {winners.map((w) => (
          <li key={w.player} className={w.player === me ? s.meRow : ""}>
            <span className={s.fig}>{w.rank}</span>
            <span>
              {w.callsign}
              {st.players.find((x) => x.player === w.player)?.bot && <span className={s.bot}>BOT</span>}
            </span>
            <span className={`${s.fig} ${p.dist}`}>{commas(w.distance)}</span>
            <span className={s.fig}>${unitsToUsd(paid(w.player) ?? w.provisionalPayoutUnits)}</span>
          </li>
        ))}
      </ol>
      {settled ? (
        <div className={s.stamp}>
          <p className={s.stampTitle}>Verified by Chainlink</p>
          <p className={s.stampBody}>
            Settled on chain, tx <span className={s.fig}>{shortAddr(settled.txHash)}</span>
          </p>
          <p className={s.stampBody}>{settled.mode === "deployed" ? "Paid by the CRE workflow report" : "Paid from a simulated CRE report"}</p>
        </div>
      ) : (
        <p className={s.fine}>Payouts are provisional until the Chainlink report settles the pot.</p>
      )}
      <button className={p.secondary} onClick={() => go({ kind: "rounds" })}>
        Next round
      </button>
    </section>
  );
}

