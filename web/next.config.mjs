import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// Public settings (NEXT_PUBLIC_* only) come from the repo-root .env; anything already set wins.
// No other variable from that file reaches the web build.
const rootEnv = new URL("../.env", import.meta.url);
if (existsSync(rootEnv)) {
  const vars = parseEnv(readFileSync(rootEnv, "utf8"));
  for (const [k, v] of Object.entries(vars)) {
    if (k.startsWith("NEXT_PUBLIC_") && process.env[k] === undefined && v) process.env[k] = v;
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: { externalDir: true },
};
export default nextConfig;
