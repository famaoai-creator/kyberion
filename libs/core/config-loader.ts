import { safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';

/**
 * Loads common project standards from the governed common knowledge tier.
 */
export function loadProjectStandards() {
  const configPath = pathResolver.knowledge('public/common/project_standards.json');
  try {
    const data = safeReadFile(configPath, { encoding: 'utf8' }) as string;
    return JSON.parse(data);
  } catch (_e) {
    // Fallback defaults if config is missing
    return {
      ignore_dirs: ['.git', 'node_modules', '.DS_Store'],
      ignore_extensions: ['.lock', '.bin'],
    };
  }
}
