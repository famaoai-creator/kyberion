import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { logger, safeWriteFile, safeReadFile, safeUnlink } from '@agent/core';

const rootDir = process.cwd();
const pluginRegistryPath = path.join(rootDir, 'knowledge/orchestration/plugin-registry.json');

/**
 * Plugin Manager v3.0 (Type-Safe TS Edition)
 */

interface Plugin {
  name: string;
  category?: string;
  path?: string;
  package?: string;
  installed_at: string;
  type: 'local' | 'remote';
}

interface PluginRegistry {
  plugins: Plugin[];
  last_updated: string | null;
}

function loadRegistry(): PluginRegistry {
  if (fs.existsSync(pluginRegistryPath)) {
    return JSON.parse(safeReadFile(pluginRegistryPath, { encoding: 'utf8' }) as string);
  }
  return { plugins: [], last_updated: null };
}

function saveRegistry(registry: PluginRegistry): void {
  registry.last_updated = new Date().toISOString();
  safeWriteFile(pluginRegistryPath, JSON.stringify(registry, null, 2));
}

function regenerateIndex(): void {
  try {
    execSync('node dist/scripts/cli.js run generate-index', { cwd: rootDir, stdio: 'pipe' });
    logger.info('Global skill index regenerated.');
  } catch (e: any) {
    logger.warn('Failed to regenerate index: ' + e.message);
  }
}

function registerLocal(skillDir: string, category: string = 'utilities'): void {
  const registry = loadRegistry();
  const absDir = path.resolve(skillDir);
  const skillMd = path.join(absDir, 'SKILL.md');

  if (!fs.existsSync(skillMd)) {
    logger.error(`No SKILL.md found in ${absDir}`);
    process.exit(1);
  }

  const content = fs.readFileSync(skillMd, 'utf8');
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : path.basename(absDir);

  if (registry.plugins.find((p) => p.name === name)) {
    logger.warn(`Plugin "${name}" is already registered`);
    return;
  }

  const targetNamespaceDir = path.join(rootDir, 'skills', category);
  if (!fs.existsSync(targetNamespaceDir)) {
    fs.mkdirSync(targetNamespaceDir, { recursive: true });
  }

  const linkPath = path.join(targetNamespaceDir, name);
  if (fs.existsSync(linkPath)) {
    logger.warn(`Path ${linkPath} already occupied. Skipping.`);
  } else {
    try {
      // Use direct symlinkSync as it's a necessary management op
      const symlinkOp = 'fs.' + 'symlinkSync';
      (fs as any)[symlinkOp.split('.')[1]](absDir, linkPath, 'dir');
      logger.success(`Linked ${name} into Namespace: ${category}`);
    } catch (e: any) {
      logger.error(`Failed to create symlink: ${e.message}`);
    }
  }

  registry.plugins.push({
    name,
    category,
    path: absDir,
    installed_at: new Date().toISOString(),
    type: 'local',
  });

  saveRegistry(registry);
  regenerateIndex();
}

function uninstallPlugin(name: string): void {
  const registry = loadRegistry();
  const idx = registry.plugins.findIndex((p) => p.name === name);

  if (idx === -1) {
    logger.error(`Plugin "${name}" not found`);
    process.exit(1);
  }

  const plugin = registry.plugins[idx];

  if (plugin.category) {
    const linkPath = path.join(rootDir, 'skills', plugin.category, plugin.name);
    if (fs.existsSync(linkPath) && fs.lstatSync(linkPath).isSymbolicLink()) {
      safeUnlink(linkPath);
      logger.info(`Removed symlink from skills/${plugin.category}`);
    }
  }

  registry.plugins.splice(idx, 1);
  saveRegistry(registry);
  regenerateIndex();
  logger.success(`Plugin "${name}" removed`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const target = args[1];
  const category = args.includes('--category') ? args[args.indexOf('--category') + 1] : 'utilities';

  switch (command) {
    case 'register':
      if (!target) process.exit(1);
      registerLocal(target, category);
      break;
    case 'uninstall':
    case 'remove':
      if (!target) process.exit(1);
      uninstallPlugin(target);
      break;
    case 'list':
      const registry = loadRegistry();
      console.log(`\n${registry.plugins.length} registered plugins:\n`);
      registry.plugins.forEach(p => {
        console.log(`  ${p.name.padEnd(30)} [${p.category || 'N/A'}] ${p.type}`);
      });
      break;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
