// Avatars on the island (CLAUDE.md "Island" > "Avatars"): the option lists and dances are the prototype's.
// Your look is stored per burner address; your name is the callsign /play uses (royale.callsign).
// Everyone else's look is derived from their lowercase address, so every viewer sees the same thing.

export type DanceId = "hype" | "spin" | "floss" | "robot" | "disco" | "flip";
export type AvatarCfg = {
  v: 1;
  name: string;
  shirt: string;
  pants: string;
  skin: string;
  hat: string;
  hatColor: string;
  face: string;
  extra: string;
  dance: DanceId;
};

export const AV = {
  shirt: ["#FF5E7E", "#8B5CFF", "#14C98E", "#FFC93C", "#4CC9F0", "#FF8A3D", "#FF7BCB", "#FFFBF5"],
  pants: ["#2B1D52", "#3A6FE0", "#6B4A2E", "#14C98E", "#FF5E7E", "#E9E2FF"],
  skin: ["#FFE1C7", "#F5C29A", "#D79A6B", "#A8693F", "#6E4127"],
  hatColor: ["#FFC93C", "#FF5E7E", "#8B5CFF", "#4CC9F0", "#14C98E", "#2B1D52"],
  hat: [["none", "None"], ["crown", "Crown"], ["cap", "Cap"], ["tophat", "Top hat"], ["beanie", "Beanie"], ["party", "Party hat"], ["halo", "Halo"]] as [string, string][],
  face: [["dots", "Bright"], ["happy", "Happy"], ["wink", "Wink"], ["shades", "Shades"]] as [string, string][],
  extra: [["none", "None"], ["scarf", "Scarf"], ["cape", "Cape"], ["chain", "Gold chain"]] as [string, string][],
};
export type SwatchKey = "shirt" | "pants" | "skin" | "hatColor";
export type ChipKey = "hat" | "face" | "extra";

export const DANCES: [DanceId, string, string][] = [
  ["hype", "Hype Hop", "Jumps with both fists pumping"],
  ["spin", "Spin Cycle", "Arms out, full-speed twirl"],
  ["floss", "Floss", "Hips one way, arms the other"],
  ["robot", "Robot", "Stiff, ticking, perfectly on beat"],
  ["disco", "Disco Point", "Point to the sky, point to the floor"],
  ["flip", "Moon Flip", "A slow-motion backflip, then a bow"],
];
export const danceName = (id: string) => (DANCES.find((d) => d[0] === id) ?? DANCES[0])[1];

const avHash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/** The look for anyone but you: a pure function of the lowercase address. Rank 0 (leaderboard #1) wears the crown. */
export function cfgFor(address: string, name: string, rank = -1): AvatarCfg {
  const h = avHash(address.toLowerCase());
  const pick = <T,>(arr: T[], k: number) => arr[(h >>> k) % arr.length];
  return {
    v: 1,
    name,
    shirt: pick(AV.shirt, 0),
    pants: pick(AV.pants, 3),
    skin: pick(AV.skin, 6),
    hat: rank === 0 ? "crown" : pick(AV.hat.filter((x) => x[0] !== "crown"), 9)[0],
    hatColor: pick(AV.hatColor, 12),
    face: pick(AV.face, 15)[0],
    extra: pick(AV.extra, 18)[0],
    dance: pick(DANCES, 21)[0],
  };
}

export const DEFAULT_AVATAR: AvatarCfg = {
  v: 1,
  name: "you",
  shirt: "#8B5CFF",
  pants: "#2B1D52",
  skin: "#F5C29A",
  hat: "cap",
  hatColor: "#FFC93C",
  face: "happy",
  extra: "scarf",
  dance: "floss",
};

export const CALLSIGN_KEY = "royale.callsign";
const avatarKey = (address: string) => `royale.avatar.${address.toLowerCase()}`;

const valid = (c: Partial<AvatarCfg>): AvatarCfg => {
  const d = DEFAULT_AVATAR;
  const inList = (v: unknown, xs: string[], dflt: string) => (typeof v === "string" && xs.includes(v) ? v : dflt);
  return {
    v: 1,
    name: typeof c.name === "string" && c.name.trim() ? c.name.trim().slice(0, 24) : d.name,
    shirt: inList(c.shirt, AV.shirt, d.shirt),
    pants: inList(c.pants, AV.pants, d.pants),
    skin: inList(c.skin, AV.skin, d.skin),
    hat: inList(c.hat, AV.hat.map((x) => x[0]), d.hat),
    hatColor: inList(c.hatColor, AV.hatColor, d.hatColor),
    face: inList(c.face, AV.face.map((x) => x[0]), d.face),
    extra: inList(c.extra, AV.extra.map((x) => x[0]), d.extra),
    dance: inList(c.dance, DANCES.map((x) => x[0]), d.dance) as DanceId,
  };
};

/** Your saved look, with `name` from royale.callsign when set there. */
export function loadAvatar(address: string | null): AvatarCfg {
  let cfg: Partial<AvatarCfg> = {};
  try {
    if (address) cfg = (JSON.parse(localStorage.getItem(avatarKey(address)) ?? "null") as Partial<AvatarCfg> | null) ?? {};
  } catch {
    /* storage blocked or corrupt: defaults */
  }
  let callsign: string | null = null;
  try {
    callsign = localStorage.getItem(CALLSIGN_KEY);
  } catch {
    /* ignore */
  }
  const out = valid(cfg);
  if (callsign && callsign.trim()) out.name = callsign.trim().slice(0, 24);
  return out;
}

export function saveAvatar(address: string | null, cfg: AvatarCfg) {
  try {
    if (address) localStorage.setItem(avatarKey(address), JSON.stringify(cfg));
    if (cfg.name && cfg.name !== DEFAULT_AVATAR.name) localStorage.setItem(CALLSIGN_KEY, cfg.name);
  } catch {
    /* storage blocked: the look lasts for this page */
  }
}

/** A random look (the studio's Shuffle), keeping the name. */
export function shuffled(name: string): AvatarCfg {
  return { ...cfgFor(Math.random().toString(36), name), name };
}
