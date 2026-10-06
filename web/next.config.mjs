import { fileURLToPath } from "node:url";

const only = process.env.ARENA_ONLY; // a | b | c: build one arena variant, stub the others
const stub = fileURLToPath(new URL("./components/arena/Stub.tsx", import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: { externalDir: true },
  typescript: { ignoreBuildErrors: Boolean(only) },
  webpack(config, { webpack }) {
    if (only) {
      const others = ["A", "B", "C"].filter((x) => x !== only.toUpperCase()).join("|");
      config.plugins.push(new webpack.NormalModuleReplacementPlugin(new RegExp(`arena/Variant(${others})$`), stub));
    }
    return config;
  },
};
export default nextConfig;
