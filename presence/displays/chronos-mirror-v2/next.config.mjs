import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.resolve(__dirname, '../../..'),
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
