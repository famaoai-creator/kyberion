# Kyberion Agent Plugin

This directory is the additive Agent Plugins v1.0.0 portable core for Kyberion.
The existing `plugins/kyberion-claude-code/` and `plugins/kyberion/` directories
remain supported as Claude Code and Cowork compatibility packages.

The portable package contains:

- `plugin.json` — the closed Agent Plugins v1 manifest.
- `mcp.json` — the portable stdio MCP declaration.
- `skills/` — reusable Agent Skills.

The included launcher is repository-native: run `pnpm build` at the Kyberion
repository root before starting the MCP server. A separately distributed
package can replace `bin/kyberion-mcp.mjs` with a bundled MCP runtime without
changing the portable manifest or skills.

Client-specific hooks and commands stay in the Claude Code compatibility
package. Kyberion governance metadata stays under the reverse-domain
`org.kyberion` extension rather than expanding the portable manifest.
