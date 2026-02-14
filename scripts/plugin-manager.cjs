#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { logger, fileUtils } = require('./lib/core.cjs');

const rootDir = path.resolve(__dirname, '..');
const pluginRegistryPath = path.join(rootDir, 'knowledge/orchestration/plugin-registry.json');

function loadRegistry() {
  if (fs.existsSync(pluginRegistryPath)) {
    return JSON.parse(fs.readFileSync(pluginRegistryPath, 'utf8'));
  }
  return { plugins: [], last_updated: null };
}

function saveRegistry(registry) {
  registry.last_updated = new Date().toISOString();
  fileUtils.writeJson(pluginRegistryPath, registry);
}

function installPlugin(packageName) {
  const registry = loadRegistry();

  if (registry.plugins.find((p) => p.package === packageName)) {
    logger.warn(`Plugin "${packageName}" is already installed`);
    return;
  }

  logger.info(`Installing plugin: ${packageName}...`);

  try {
    execSync(`npm install ${packageName}`, { cwd: rootDir, stdio: 'pipe' });
  } catch (err) {
    logger.error(`Failed to install ${packageName}: ${err.message}`);
    process.exit(1);
  }

  // Try to discover skill metadata from the installed package
  let skillMeta = { name: packageName, description: 'External plugin' };
  try {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'node_modules', packageName, 'package.json'), 'utf8')
    );
    skillMeta.description = pkgJson.description || skillMeta.description;
    skillMeta.version = pkgJson.version;
    if (pkgJson.geminiSkill) {
      skillMeta = { ...skillMeta, ...pkgJson.geminiSkill };
    }
  } catch (_e) {
    // Use defaults
  }

  registry.plugins.push({
    package: packageName,
    name: skillMeta.name,
    description: skillMeta.description,
    version: skillMeta.version || 'unknown',
    installed_at: new Date().toISOString(),
    type: 'npm',
  });

  saveRegistry(registry);
  logger.success(`Plugin "${packageName}" installed and registered`);
}

function registerLocal(skillDir) {
  const registry = loadRegistry();
  const absDir = path.resolve(skillDir);
  const skillMd = path.join(absDir, 'SKILL.md');

  if (!fs.existsSync(skillMd)) {
    logger.error(`No SKILL.md found in ${absDir}`);
    process.exit(1);
  }

  const content = fs.readFileSync(skillMd, 'utf8');
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  const descMatch = content.match(/^description:\s*(.+)$/m);

  const name = nameMatch ? nameMatch[1].trim() : path.basename(absDir);
  const description = descMatch ? descMatch[1].trim() : '';

  if (registry.plugins.find((p) => p.name === name)) {
    logger.warn(`Plugin "${name}" is already registered`);
    return;
  }

  registry.plugins.push({
    package: null,
    name,
    description,
    path: absDir,
    installed_at: new Date().toISOString(),
    type: 'local',
  });

  saveRegistry(registry);
  logger.success(`Local skill "${name}" registered from ${absDir}`);
}

function uninstallPlugin(nameOrPackage) {
  const registry = loadRegistry();
  const idx = registry.plugins.findIndex(
    (p) => p.name === nameOrPackage || p.package === nameOrPackage
  );

  if (idx === -1) {
    logger.error(`Plugin "${nameOrPackage}" not found`);
    process.exit(1);
  }

  const plugin = registry.plugins[idx];

  if (plugin.type === 'npm') {
    try {
      execSync(`npm uninstall ${plugin.package}`, { cwd: rootDir, stdio: 'pipe' });
    } catch (e) {
      logger.warn(`npm uninstall failed: ${e.message}`);
    }
  }

  registry.plugins.splice(idx, 1);
  saveRegistry(registry);
  logger.success(`Plugin "${nameOrPackage}" removed`);
}

function listPlugins() {
  const registry = loadRegistry();
  if (registry.plugins.length === 0) {
    console.log('No plugins installed.');
    return;
  }

  console.log(`\n${registry.plugins.length} plugins:\n`);
  for (const p of registry.plugins) {
    const source = p.type === 'npm' ? p.package : p.path;
    console.log(`  ${p.name.padEnd(30)} [${p.type}] ${p.description}`);
    console.log(`    ${' '.repeat(30)} ${source}`);
  }
}

// CLI
const args = process.argv.slice(2);
const command = args[0];
const target = args[1];

switch (command) {
  case 'install':
    if (!target) {
      logger.error('Usage: plugin-manager install <npm-package>');
      process.exit(1);
    }
    installPlugin(target);
    break;
  case 'register':
    if (!target) {
      logger.error('Usage: plugin-manager register <local-skill-dir>');
      process.exit(1);
    }
    registerLocal(target);
    break;
  case 'uninstall':
  case 'remove':
    if (!target) {
      logger.error('Usage: plugin-manager uninstall <name>');
      process.exit(1);
    }
    uninstallPlugin(target);
    break;
  case 'list':
    listPlugins();
    break;
  default:
    console.log(`
Plugin Manager - External skill management

Usage:
  node scripts/plugin-manager.cjs install <npm-package>   Install npm plugin
  node scripts/plugin-manager.cjs register <skill-dir>    Register local skill
  node scripts/plugin-manager.cjs uninstall <name>        Remove plugin
  node scripts/plugin-manager.cjs list                    List plugins
`);
}
