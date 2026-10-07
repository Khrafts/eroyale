// The island's kit for /play and /arena's DOM: chip, primary and ghost buttons, card, panel and panel head, segmented
// toggle, bot tag, and the top bar (brand chip back to the island, wallet chip). Styles in kit.module.css, values from
// app/theme.css and lib/theme.ts. No hooks and no engine access: screens pass what to show.
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode } from "react";
import { GAME, ISLAND, ink, paper, sun } from "@/lib/theme";
import k from "./kit.module.css";

export { k as kit };

type Game = keyof typeof GAME;
/** A game key ("royale", "predict", ...) or any colour (a theme.ts constant). */
export type Tint = Game | string;
const tint = (c: Tint | undefined): CSSProperties | undefined => (c ? ({ ["--c" as string]: c in GAME ? GAME[c as Game] : c } as CSSProperties) : undefined);
const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");
const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Glass pill over a scene or on paper. `fill` gives it a game-meaning colour (MEANING.long.fill, ...): ink text on it. */
export function Chip({ fill, className, style, ...rest }: HTMLAttributes<HTMLSpanElement> & { fill?: string }) {
  return <span {...rest} className={cx(k.chip, fill && k.chipFill, className)} style={{ ...tint(fill), ...style }} />;
}

type BtnOwn = { color?: Tint; big?: boolean };
type BtnProps = (ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined }) | (AnchorHTMLAttributes<HTMLAnchorElement> & { href: string });
/** Primary button in the game's colour (default royale coral). `big` is the display-face game button with ink text
 *  (LONG on mint, SHORT on violet). With `href` it renders a link. */
export function Button({ color, big, className, style, ...rest }: BtnOwn & BtnProps) {
  const c = cx(k.btn, big && k.big, className);
  const st = { ...tint(color), ...style };
  if (typeof rest.href === "string") return <a {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)} className={c} style={st} />;
  return <button type="button" {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)} className={c} style={st} />;
}

/** Paper button with an ink outline, for the second action. With `href` it renders a link. */
export function GhostButton({ className, ...rest }: BtnProps) {
  if (typeof rest.href === "string") return <a {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)} className={cx(k.ghost, className)} />;
  return <button type="button" {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)} className={cx(k.ghost, className)} />;
}

/** White card on paper. Soft (hairline border) for figures and rows; `raised` (ink border, hard shadow) for cards you press. */
export function Card({ raised, className, ...rest }: HTMLAttributes<HTMLDivElement> & { raised?: boolean }) {
  return <div {...rest} className={cx(k.card, raised && k.raised, className)} />;
}

/** Paper panel with an ink outline and the panel shadow. */
export function Panel({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <section {...rest} className={cx(k.panel, className)} />;
}

/** The game-coloured head with the island's two soft white circles: eyebrow, title, optional close and extra content. */
export function PanelHead({ color = "royale", eyebrow, title, onClose, children, className }: { color?: Tint; eyebrow?: ReactNode; title: ReactNode; onClose?: () => void; children?: ReactNode; className?: string }) {
  return (
    <header className={cx(k.phead, className)} style={tint(color)}>
      <div className={k.ph}>
        <span className={k.eyebrow}>{eyebrow}</span>
        {onClose && (
          <button type="button" className={k.x} aria-label="Close" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      <h2 className={k.title}>{title}</h2>
      {children && <div className={k.headBody}>{children}</div>}
    </header>
  );
}

/** Segmented toggle (the island's Island/List switch). */
export function Segmented<T extends string>({ options, value, onChange, label, className }: { options: readonly { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string; className?: string }) {
  return (
    <div className={cx(k.seg, className)} role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The small tag after a bot's name (also "offline" on offline amounts). */
export function BotTag({ children = "bot" }: { children?: ReactNode }) {
  return <span className={k.bot}>{children}</span>;
}

/** The island's brand mark. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cx(k.mark, className)}>
      <circle cx="16" cy="16" r="15" fill={ink} />
      <path d="M7 23h18" stroke={paper} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M16 22V13M16 13c-3-4-6.5-3-7.5 1.5M16 13c3-4 6.5-3 7.5 1.5" stroke={ISLAND.wave} strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <circle cx="16" cy="8" r="2.6" fill={sun} stroke={paper} strokeWidth="1" />
    </svg>
  );
}

/** Top bar: the brand chip (a link back to the island at `/`), whatever the screen puts in the middle, and the wallet
 *  chip with the burner address (`burner().address`, no balance). */
export function TopBar({ wallet, children, className }: { wallet?: string | null; children?: ReactNode; className?: string }) {
  return (
    <header className={cx(k.top, className)}>
      <a className={cx(k.chip, k.brand)} href="/" aria-label="Royale Isle, back to the island">
        <BrandMark />
        <span className={k.word}>Royale Isle</span>
      </a>
      {children}
      {wallet && (
        <span className={k.right}>
          <span className={cx(k.chip, k.wallet)} title={wallet}>
            {shortAddr(wallet)}
          </span>
        </span>
      )}
    </header>
  );
}
