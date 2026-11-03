import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputFileTracingRoot =
  process.platform === 'win32' ? __dirname : path.resolve(__dirname, '../../..');

/**
 * Chronos compatibility app: only the health probe and the redirect proxy
 * (src/proxy.ts) remain; the operations console is served by Concierge.
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  // Windows runners expose junctions such as AppData\Local\Application Data
  // that @vercel/nft cannot scan.
  outputFileTracingRoot,
  serverExternalPackages: ['@agent/core'],
};

export default nextConfig;
