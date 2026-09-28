/**
 * The single ordered list of plugin manifest locations, relative to a plugin
 * root. Every reader (managed install, grant resolution, skill loader, view
 * contract, pack) uses it so precedence cannot drift; managed installs refuse
 * packages that contain more than one (`manifest_ambiguous`), so precedence
 * only matters for in-tree official packages.
 *
 * Kyberion/Cowork first, then the Claude Code location, then the Agent
 * Plugins v1 portable root manifest. Leaf module: no imports.
 */
export const PLUGIN_MANIFEST_CANDIDATES: readonly string[] = Object.freeze([
  'plugin-manifest.json',
  '.claude-plugin/plugin.json',
  'plugin.json',
]);
