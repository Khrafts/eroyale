// Engine HTTP base: NEXT_PUBLIC_ENGINE_HTTP, else NEXT_PUBLIC_ENGINE_WS with ws->http and the /ws path dropped.
export function engineHttp(): string {
  const explicit = process.env.NEXT_PUBLIC_ENGINE_HTTP;
  if (explicit) return explicit.replace(/\/$/, "");
  const ws = process.env.NEXT_PUBLIC_ENGINE_WS ?? "ws://localhost:8787/ws";
  return ws.replace(/^ws/, "http").replace(/\/ws\/?(\?.*)?$/, "");
}
