import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@agent/core", "@copilotkit/react-core", "@copilotkit/react-ui", "@copilotkit/runtime"],
  serverExternalPackages: ["langium", "mermaid"],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@agent/core": path.resolve(__dirname, "../../libs/core"),
    };
    // Ensure .ts and .tsx files in the aliased directory are resolvable
    config.resolve.extensions = [
      ...new Set([".ts", ".tsx", ...config.resolve.extensions]),
    ];
    return config;
  },
};

export default nextConfig;
