import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Enable static export for desktop bundling (Next 16)
  output: 'export',
  images: {
    unoptimized: true
  }
};

export default nextConfig;
