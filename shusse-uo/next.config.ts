import type { NextConfig } from "next";

const isNative = process.env.BUILD_TARGET === "native";

const nextConfig: NextConfig = {
  ...(isNative
    ? {
        output: "export",
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
