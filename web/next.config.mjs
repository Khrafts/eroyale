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

// The island's lighthouse shows the escrow: contracts/deployments/<CHAIN>.json at build time, if present. Only the
// chain name and the escrow address reach the build. CHAIN comes from the environment, else the repo-root .env.
if (!process.env.NEXT_PUBLIC_ESCROW_ADDRESS) {
  let chain = process.env.CHAIN;
  if (!chain && existsSync(rootEnv)) chain = parseEnv(readFileSync(rootEnv, "utf8")).CHAIN;
  const file = chain && chain !== "off" && /^[a-z0-9-]+$/.test(chain) ? new URL(`../contracts/deployments/${chain}.json`, import.meta.url) : null;
  if (file && existsSync(file)) {
    try {
      const d = JSON.parse(readFileSync(file, "utf8"));
      if (/^0x[0-9a-fA-F]{40}$/.test(d.escrow ?? "")) {
        process.env.NEXT_PUBLIC_ESCROW_ADDRESS = d.escrow;
        process.env.NEXT_PUBLIC_ESCROW_CHAIN = String(d.chain ?? chain);
      }
    } catch {
      /* unreadable deployment file: the lighthouse says "Not deployed" */
    }
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: { externalDir: true },
};
export default nextConfig;
