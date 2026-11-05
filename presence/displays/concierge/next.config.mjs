/** @type {import('next').NextConfig} */
const nextConfig = {
  // MOS is intentionally read-only. Treat @agent/core as a server-external
  // package so it resolves via node_modules (workspace symlink → dist/) at
  // runtime rather than being bundled into the client.
  reactStrictMode: true,
  // The operations console routes (/api/ops, the former Chronos API) reach
  // the agent runtime: node-pty is a native addon and the ACP SDK is a
  // runtime dependency of @agent/core, so neither is bundled.
  serverExternalPackages: [
    '@agent/core',
    '@agent/shared-vision',
    'node-pty',
    '@agentclientprotocol/sdk',
  ],
  // PH-02 (carried over from Chronos): operations console pages may frame
  // only same-origin documents (plugin iframe views, deliverable previews).
  // Scoped to the /ops pages; API routes send their own policies (the plugin
  // view frame route sets a sandbox CSP and must not get a second one).
  async headers() {
    // frame-src: the console frames only same-origin documents; frame-ancestors:
    // nothing but Concierge itself may frame the console (clickjacking).
    const frameSameOrigin = [
      { key: 'Content-Security-Policy', value: "frame-src 'self'; frame-ancestors 'self'" },
    ];
    return [
      { source: '/ops', headers: frameSameOrigin },
      { source: '/ops/:path*', headers: frameSameOrigin },
    ];
  },
};

export default nextConfig;
