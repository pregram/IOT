import type { NextConfig } from "next";

/**
 * Two build modes from one file:
 *  - default (dev server / local game host): output "standalone".
 *  - NEXT_PUBLIC_STATIC_EXPORT=1 (GitHub Actions -> GitHub Pages): a static export
 *    into ./out, the only thing Pages can serve. CI also sets NEXT_PUBLIC_BASE_PATH
 *    to the repo name (/IOT), because project Pages live under
 *    https://<user>.github.io/<repo>/ and every _next/* asset 404s without it.
 */
const isStatic = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1";

const shared = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

const nextConfig: NextConfig = isStatic
  ? {
      ...shared,
      output: "export",
      trailingSlash: true,
      images: { unoptimized: true },
      basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
    }
  : {
      ...shared,
      output: "standalone",
    };

export default nextConfig;