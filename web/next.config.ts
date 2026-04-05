import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Silence Turbopack warning — no custom config needed, xrpl is browser-compatible
  turbopack: {},
};

export default nextConfig;
