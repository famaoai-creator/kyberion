/**
 * Source-tree launcher for the portable Agent Plugins package.
 *
 * The package descriptor is portable; this repository-native launcher keeps
 * the existing compiled Kyberion MCP server as the single runtime entrypoint.
 * A packaged distribution can replace this launcher with its bundled server.
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = process.env.PLUGIN_ROOT
  ? path.resolve(process.env.PLUGIN_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const serverPath = path.join(repoRoot, 'dist', 'scripts', 'mcp_server.js');

await import(pathToFileURL(serverPath).href);
