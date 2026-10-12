import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
/** Isolated synthetic component fixture; no production API/auth routes. */
export default {
  reactStrictMode: true,
  serverExternalPackages: ['@agent/core'],
  webpack(config) {
    config.resolve.alias['@'] = path.resolve(here, '../../src');
    return config;
  },
};
