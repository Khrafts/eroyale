// "My activity": the lobbies and rounds this browser joined or created, kept in localStorage. A stopgap until the
// engine indexes activity per player; the page reads each id's state from GET /lobbies/:id (archived ones included).
const KEY = "royale.activity";
const ROUNDS = "royale.rounds"; // predict.ts rememberJoined(), from before this log existed

export type ActivityEntry = { id: number; role: "player" | "creator"; at: number };

function read(): ActivityEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as ActivityEntry[];
  } catch {
    return [];
  }
}

export function recordActivity(id: number, role: ActivityEntry["role"] = "player") {
  try {
    const xs = read();
    if (xs.some((x) => x.id === id && x.role === role)) return;
    localStorage.setItem(KEY, JSON.stringify([...xs, { id, role, at: Date.now() }].slice(-100)));
  } catch {
    /* storage blocked */
  }
}

/** Newest first, one entry per id ("player" wins over "creator"), with older predict joins folded in. */
export function activity(): ActivityEntry[] {
  const xs = read();
  try {
    for (const id of JSON.parse(localStorage.getItem(ROUNDS) ?? "[]") as number[]) {
      if (!xs.some((x) => x.id === id)) xs.push({ id, role: "player", at: 0 });
    }
  } catch {
    /* ignore */
  }
  const byId = new Map<number, ActivityEntry>();
  for (const x of xs) {
    const had = byId.get(x.id);
    if (!had || (had.role === "creator" && x.role === "player")) byId.set(x.id, { ...x, at: Math.max(x.at, had?.at ?? 0) });
  }
  return [...byId.values()].sort((a, b) => b.at - a.at || b.id - a.id);
}
