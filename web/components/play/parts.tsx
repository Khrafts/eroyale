// Pieces both phone modes share: the screen head (the kit's panel head, full width, with the screen's h1) and the
// wind pennant for long and short.
import type { ReactNode } from "react";
import { kit } from "@/components/kit";
import type { Side } from "@/lib/events";
import { GAME, ink } from "@/lib/theme";
import s from "./play.module.css";

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
