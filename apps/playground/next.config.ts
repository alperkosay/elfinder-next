import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp", "adm-zip"],
  // elfinder-next lives in packages/, outside this app. Without the repository root
  // as the tracing root, a standalone build leaves it and sharp's binary behind.
  outputFileTracingRoot: path.join(__dirname, "../../"),
};

export default nextConfig;
