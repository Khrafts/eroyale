// The end-state action block (CLAUDE.md "Navigation" rule 5). Its own module so a screen that does not show it does
// not carry it: import from "@/components/kit/actions". Server-compatible (no hooks).
import type { CSSProperties, ReactNode } from "react";
import { NAV_GAMES, navGame, type GameId } from "@/lib/nav";
import { ink } from "@/lib/theme";
import { Button, GhostButton } from "./index";
import Link from "./link";
import n from "./nav.module.css";

const tint = (c: string) => ({ ["--c" as string]: c }) as CSSProperties;

/** One action in an end-state block: a link with `href` (`replace` for a lateral move), or a button with `onClick`. */
export type Action = { label: ReactNode; href?: string; onClick?: () => void; replace?: boolean };
const act = (a: Action) => (a.href ? { href: a.href, onClick: a.onClick, replace: a.replace } : { onClick: a.onClick });

/** The end-state action block (CLAUDE.md "Navigation" rule 5; the duel result screen is the model): the primary next
 *  action in the game's colour, "Watch on the big screen" when `watch` is given, `more` (screen-specific ghost
 *  actions), the other games, and the island. Server-compatible: no hooks. */
export function EndActions({ game, primary, watch, more, className }: { game: GameId; primary: Action; watch?: string | null; more?: Action[]; className?: string }) {
  const others = NAV_GAMES.filter((g) => g.id !== game && g.id !== "island");
  return (
    <nav className={className ? `${n.actions} ${className}` : n.actions} aria-label="What next">
      <Button color={game === "island" ? ink : navGame(game).color} {...act(primary)}>
        {primary.label}
      </Button>
      {watch && <GhostButton href={watch}>Watch on the big screen</GhostButton>}
      {more?.map((a, i) => (
        <GhostButton key={i} {...act(a)}>
          {a.label}
        </GhostButton>
      ))}
      <div className={n.others}>
        {others.map((g) => (
          <Link key={g.id} href={g.href} className={n.other} style={tint(g.color)}>
            <i className={n.dot} aria-hidden="true" />
            {g.name}
          </Link>
        ))}
      </div>
      {game !== "island" && <GhostButton href="/">Back to the island</GhostButton>}
    </nav>
  );
}
