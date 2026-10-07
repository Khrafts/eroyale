// Pieces both phone modes share: the screen head (the kit's panel head, full width, with the screen's h1) and the
// wind pennant for long and short.
import type { ReactNode } from "react";
import { kit } from "@/components/kit";
import type { Side } from "@/lib/events";
import { GAME, ink } from "@/lib/theme";
import s from "./play.module.css";

/** Every figure in a sentence in the mono face: wraps each number (with its $, sign, %, x or ordinal) in `.fig`. */
const FIG = /((?<![A-Za-z0-9])[+−-]?\$?\d[\d,]*(?:\.\d+)?(?::\d+)*(?:%|x|st|nd|rd|th)?(?![A-Za-z0-9]))/;
export function figs(text: string): ReactNode {
  const parts = text.split(FIG);
  if (parts.length === 1) return text;
  return parts.map((t, i) => (i % 2 ? <span key={i} className={s.fig}>{t}</span> : t));
}

const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

/** The game-coloured head with the island's soft white circles: an eyebrow or a top row (back button, clock), the
 *  screen's title, and anything after. */
export function Head({ game, eyebrow, top, title, children, className }: { game: keyof typeof GAME; eyebrow?: ReactNode; top?: ReactNode; title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={cx(kit.phead, s.head, className)} style={{ ["--c" as string]: GAME[game] }}>
      {eyebrow !== undefined && (
        <div className={kit.ph}>
          <span className={kit.eyebrow}>{eyebrow}</span>
        </div>
      )}
      {top !== undefined && <div className={kit.ph}>{top}</div>}
      {title !== undefined && <h1 className={s.headTitle}>{title}</h1>}
      {children}
    </header>
  );
}

/** A wind pennant: long flies right in mint, short flies left in violet, both outlined in ink. */
export function Pennant({ side, size = 22, plain }: { side: Side; size?: number; plain?: boolean }) {
  const w = size * 1.4;
  const st = plain ? { fill: ink } : { stroke: ink, strokeWidth: 1.6, strokeLinejoin: "round" as const };
  return (
    <svg width={w} height={size} viewBox="-1 -1 30 22" aria-hidden className={plain ? undefined : side === 1 ? s.long : s.short}>
      {side === 1 ? (
        <>
          <rect x="1" y="0" width="2.5" height="20" fill={ink} />
          <path d="M3.5 1 L27 6.5 L3.5 12 Z" fill="currentColor" {...st} />
        </>
      ) : (
        <>
          <rect x="24.5" y="0" width="2.5" height="20" fill={ink} />
          <path d="M24.5 1 L1 6.5 L24.5 12 Z" fill="currentColor" {...st} />
        </>
      )}
    </svg>
  );
}

/** Between `final` and `settled`: the settlement report is on its way through Chainlink CRE. A mint arc turns in an
 *  ink ring (a still mint dot under reduced motion); the confirmed stamp replaces it when `settled` lands. */
export function Settling() {
  return (
    <div className={`${s.stamp} ${s.settling}`} role="status" aria-live="polite">
      <p className={`${s.stampTitle} ${s.settlingTitle}`}>
        <span className={s.spinner} aria-hidden="true" />
        Chainlink CRE is running the settlement
      </p>
      <p className={s.stampBody}>Payouts above use the closing price. They are provisional until the report lands on Base Sepolia.</p>
    </div>
  );
}

/** After the end time, before `final`: the engine waits for the match's last one-minute Coinbase candle to close.
 *  Same card and spinner as `Settling`. */
export function WaitingClose() {
  return (
    <div className={`${s.stamp} ${s.settling}`} role="status" aria-live="polite">
      <p className={`${s.stampTitle} ${s.settlingTitle}`}>
        <span className={s.spinner} aria-hidden="true" />
        Waiting for the closing price
      </p>
      <p className={s.stampBody}>Settlement uses the match&apos;s last one-minute Coinbase candle, final about a minute after the end. Until then the payouts above are at live prices.</p>
    </div>
  );
}
