// The island's kit for /play, /duel, /arena's DOM and the 404: chip, primary and ghost buttons, card, panel and panel
// head, segmented toggle, bot tag, the app bar (TopBar: back, brand, game switcher, you chip) and the end-state action
// block (EndActions, in actions.tsx: import it from "@/components/kit/actions", not from here). Styles in kit.module.css, values from app/theme.css and lib/theme.ts. No hooks and no engine
// access here (server components can render it). The app bar is bar.tsx (client); its switcher (switcher.tsx) and you
// chip (you.tsx) load lazily, outside /play's and /arena's first-load JS (server-rendered where the page is).
// In-app links are the kit's Link (link.tsx: Next's router, no reload). Web/NOTES.md "Navigation" documents the API.
import Link, { type AppLinkProps } from "./link";
export { default as AppLink } from "./link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode } from "react";
import { GAME } from "@/lib/theme";
import { EARLY } from "@/lib/nav";
import k from "./kit.module.css";

export { k as kit };

type Game = keyof typeof GAME;
/** A game key ("royale", "predict", ...) or any colour (a theme.ts constant). */
export type Tint = Game | string;
const tint = (c: Tint | undefined): CSSProperties | undefined => (c ? ({ ["--c" as string]: c in GAME ? GAME[c as Game] : c } as CSSProperties) : undefined);
const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

/** Glass pill over a scene or on paper. `fill` gives it a game-meaning colour (MEANING.long.fill, ...): ink text on it. */
export function Chip({ fill, className, style, ...rest }: HTMLAttributes<HTMLSpanElement> & { fill?: string }) {
  return <span {...rest} className={cx(k.chip, fill && k.chipFill, className)} style={{ ...tint(fill), ...style }} />;
}

type BtnOwn = { color?: Tint; big?: boolean };
type LinkProps = AppLinkProps;
type BtnProps = (ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined }) | LinkProps;
/** Primary button in the game's colour (default royale coral). `big` is the display-face game button with ink text
 *  (LONG on mint, SHORT on violet). With `href` it renders a link. */
export function Button({ color, big, className, style, ...rest }: BtnOwn & BtnProps) {
  const c = cx(k.btn, big && k.big, className);
  const st = { ...tint(color), ...style };
  if (typeof rest.href === "string") return <Link {...(rest as LinkProps)} className={c} style={st} />;
  return <button type="button" {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)} className={c} style={st} />;
}

/** Paper button with an ink outline, for the second action. With `href` it renders a link. */
export function GhostButton({ className, ...rest }: BtnProps) {
  if (typeof rest.href === "string") return <Link {...(rest as LinkProps)} className={cx(k.ghost, className)} />;
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

/** The "Early access" label for a game still being polished (nav.ts `early`). */
export function EarlyBadge({ className }: { className?: string }) {
  return <span className={cx(k.early, className)}>{EARLY}</span>;
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

export { TopBar, BrandMark, type Back } from "./bar";
