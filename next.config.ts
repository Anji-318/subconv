import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloudflare Pages 部署：由 @cloudflare/next-on-pages 处理，不用 standalone
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: false,
  poweredByHeader: false,
  compress: true,
};

export default nextConfig;
