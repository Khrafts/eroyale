"use client";
// Avatar heads on the phone: the island's chibi head and shoulders (components/island/world/avatar/rig.ts), drawn
// front-on in SVG from the same config. Yours comes from royale.avatar.<address>, everyone else's from cfgFor(address).
import { useEffect, useState } from "react";
import { cfgFor, loadAvatar, type AvatarCfg } from "@/lib/island/avatar";
import { ISLAND, coral, ink, paper, sun } from "@/lib/theme";

// The rig's units (head radius 0.45) at 60 px per unit, head centre at the origin, y down.
const SW = 3.5; // ink outline, about 2 px at chip size

function Hat({ c }: { c: AvatarCfg }) {
  const o = { stroke: ink, strokeWidth: SW, strokeLinejoin: "round" as const };
  switch (c.hat) {
    case "crown":
      return (
        <g {...o} fill={sun}>
          <path d="M-17 -21 L-17 -36 L-11 -46 L-6 -36 L0 -48 L6 -36 L11 -46 L17 -36 L17 -21 Z" />
          <circle cx={-9} cy={-28} r={2.6} fill={coral} strokeWidth={0} />
          <circle cx={9} cy={-28} r={2.6} fill={ISLAND.sky} strokeWidth={0} />
        </g>
      );
    case "cap":
      return (
        <g {...o} fill={c.hatColor}>
          <path d="M-28.2 -4 A28.2 28.2 0 0 1 28.2 -4 Z" />
          <ellipse cx={0} cy={-5} rx={19} ry={5} />
          <circle cx={0} cy={-32} r={3.6} fill={ink} />
        </g>
      );
    case "tophat":
      return (
        <g {...o}>
          <rect x={-18} y={-60} width={36} height={37} rx={2} fill={ink} />
          <rect x={-18} y={-34} width={36} height={8} fill={c.hatColor} strokeWidth={0} />
          <ellipse cx={0} cy={-23} rx={30} ry={4.5} fill={ink} />
        </g>
      );
    case "beanie":
      return (
        <g {...o} fill={c.hatColor}>
          <path d="M-28.2 -3 A28.2 32.4 0 0 1 28.2 -3 Z" />
          <rect x={-28} y={-10} width={56} height={11} rx={5.5} />
          <circle cx={0} cy={-37} r={7.8} fill={paper} />
        </g>
      );
    case "party":
      return (
        <g {...o} transform="translate(5 -22) rotate(12.6)">
          <path d="M-14.4 0 L0 -37 L14.4 0 Z" fill={c.hatColor} />
          <circle cx={0} cy={-38} r={5.4} fill={sun} />
        </g>
      );
    case "halo":
      return <ellipse cx={0} cy={-47} rx={18} ry={4.5} fill="none" stroke={sun} strokeWidth={4} />;
    default:
      return null;
  }
}

function Face({ c }: { c: AvatarCfg }) {
  const dot = (x: number) => <circle cx={x} cy={-3} r={3.6} fill={ink} />;
  const arc = (x: number) => <path d={`M${x - 4} -2 A4 4 0 0 1 ${x + 4} -2`} fill="none" stroke={ink} strokeWidth={2.6} strokeLinecap="round" />;
  return (
    <g>
      <ellipse cx={-16.2} cy={6} rx={4.8} ry={2.9} fill={coral} opacity={0.45} />
      <ellipse cx={16.2} cy={6} rx={4.8} ry={2.9} fill={coral} opacity={0.45} />
      <path d="M-4.2 7.8 A4.2 4.2 0 0 0 4.2 7.8" fill="none" stroke={ink} strokeWidth={2.6} strokeLinecap="round" />
      {c.face === "happy" ? (
        <>
          {arc(-9.6)}
          {arc(9.6)}
        </>
      ) : c.face === "wink" ? (
        <>
          {dot(-9.6)}
          {arc(9.6)}
        </>
      ) : c.face === "shades" ? (
        <>
          <rect x={-19.8} y={-8} width={39.6} height={9} rx={3} fill={ink} />
          <rect x={-15} y={-6.6} width={10} height={2.6} rx={1.3} fill={ISLAND.wave} />
        </>
      ) : (
        <>
          {dot(-9.6)}
          {dot(9.6)}
        </>
      )}
    </g>
  );
}

/** Head and shoulders, `size` px tall. Decorative unless `label` is given. */
export function AvatarHead({ cfg, size = 36, label, className }: { cfg: AvatarCfg; size?: number; label?: string; className?: string }) {
  const o = { stroke: ink, strokeWidth: SW, strokeLinejoin: "round" as const };
  return (
    <svg
      className={className}
      width={size * (76 / 104)}
      height={size}
      viewBox="-38 -56 76 104"
      overflow="visible"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ flex: "none", display: "inline-block" }}
    >
      {cfg.extra === "cape" && <rect x={-25} y={20} width={50} height={28} rx={8} fill={cfg.hatColor} {...o} />}
      <path d="M-19 46 L-19 36 A17 17 0 0 1 -2 19 L2 19 A17 17 0 0 1 19 36 L19 46 Z" fill={cfg.shirt} {...o} />
      {cfg.extra === "scarf" && (
        <g {...o} fill={cfg.hatColor}>
          <rect x={6} y={24} width={8} height={20} rx={3} transform="rotate(9 10 24)" />
          <rect x={-16} y={19} width={32} height={9} rx={4.5} />
        </g>
      )}
      {cfg.extra === "chain" && <path d="M-11 22 Q0 36 11 22" fill="none" stroke={sun} strokeWidth={3} />}
      <circle cx={0} cy={0} r={27} fill={cfg.skin} {...o} />
      <Face c={cfg} />
      <Hat c={cfg} />
    </svg>
  );
}

/** Anyone's head: derived from the lowercase address, the same look every viewer sees. */
export function PlayerHead({ address, name, size }: { address: string; name: string; size?: number }) {
  return <AvatarHead cfg={cfgFor(address, name)} size={size} />;
}

/** Your look: the island's saved avatar for this address when there is one, else the look derived from the address. */
export function useMyAvatar(address: string | null, name: string): AvatarCfg | null {
  const [cfg, setCfg] = useState<AvatarCfg | null>(null);
  useEffect(() => {
    if (!address) return setCfg(null);
    let saved = false;
    try {
      saved = localStorage.getItem(`royale.avatar.${address.toLowerCase()}`) !== null;
    } catch {
      /* storage blocked */
    }
    setCfg(saved ? { ...loadAvatar(address), name } : cfgFor(address, name));
  }, [address, name]);
  return cfg;
}
