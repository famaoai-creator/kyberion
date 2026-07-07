/** @type {import('next').NextConfig} */
const nextConfig = {
  // MOS is intentionally read-only. Treat @agent/core as a server-external
  // package so it resolves via node_modules (workspace symlink → dist/) at
  // runtime rather than being bundled into the client.
  reactStrictMode: true,
  serverExternalPackages: ['@agent/core'],
};

export default nextConfig;
