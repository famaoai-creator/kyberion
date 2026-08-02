import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputFileTracingRoot =
  process.platform === 'win32' ? __dirname : path.resolve(__dirname, '../../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Windows runners expose junctions such as AppData\Local\Application Data
  // that @vercel/nft cannot scan. The Windows build only needs the Chronos
  // workspace because @agent/core remains an external server package.
  outputFileTracingRoot,
  typescript: {
    ignoreBuildErrors: true,
  },
  transpilePackages: [],
  // Core is built as a workspace package before the UI build. Keep its
  // Node-oriented server modules external so dynamic capability/service
  // discovery is evaluated by Node rather than webpack.
  serverExternalPackages: ['@agent/core', 'node-pty', '@agentclientprotocol/sdk'],
};

export default nextConfig;
