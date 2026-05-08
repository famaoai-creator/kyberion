import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.resolve(__dirname, "../../.."),
  typescript: {
    ignoreBuildErrors: true,
  },
  transpilePackages: ["@agent/core"],
  serverExternalPackages: ["node-pty", "@agentclientprotocol/sdk"],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@agent/core": path.resolve(__dirname, "../../../libs/core"),
    };
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias || {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    config.resolve.extensions = [
      ...new Set([".ts", ".tsx", ...config.resolve.extensions]),
    ];
    return config;
  },
};

export default nextConfig;
