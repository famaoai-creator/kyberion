#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runSkill } = require('./lib/skill-wrapper.cjs');

const rootDir = path.resolve(__dirname, '..');

const argv = createStandardYargs()
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for the catalog markdown file',
    default: path.join(rootDir, 'work', 'SKILL-CATALOG.md'),
  })
  .help().argv;

const SKIP_DIRS = new Set([
  'node_modules',
  'knowledge',
  'scripts',
  'schemas',
  'templates',
  'evidence',
  'coverage',
  'test-results',
  'work',
  'nonfunctional',
  'dist',
  'tests',
  '.github',
]);

/**
 * Parse YAML frontmatter from a SKILL.md content string.
 * Returns an object with name, description, status (or empty strings).
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = match[1];
  const get = (key) => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  return {
    name: get('name'),
    description: get('description'),
    status: get('status'),
  };
}

/**
 * Check structural features of a skill directory.
 */
function inspectSkillDir(dirPath) {
  const hasScriptsDir = fs.existsSync(path.join(dirPath, 'scripts'));
  const hasPackageJson = fs.existsSync(path.join(dirPath, 'package.json'));

  let hasTypeScript = false;
  if (hasScriptsDir) {
    const files = fs.readdirSync(path.join(dirPath, 'scripts'));
    hasTypeScript = files.some((f) => /\.ts$/.test(f));
  }
  // Also check root-level .ts files
  if (!hasTypeScript) {
    try {
      const rootFiles = fs.readdirSync(dirPath);
      hasTypeScript = rootFiles.some((f) => /\.ts$/.test(f));
    } catch (_) {
      /* ignore */
    }
  }

  return { hasScriptsDir, hasPackageJson, hasTypeScript };
}

/**
 * Derive a CLI command string for an implemented skill.
 */
function deriveCLICommand(dirName) {
  const scriptsDir = path.join(rootDir, dirName, 'scripts');
  if (!fs.existsSync(scriptsDir)) return `node ${dirName}/`;
  const scripts = fs.readdirSync(scriptsDir).filter((f) => /\.(cjs|js|mjs)$/.test(f));
  if (scripts.length > 0) {
    return `node ${dirName}/scripts/${scripts[0]}`;
  }
  return `node ${dirName}/`;
}

runSkill('generate-docs', () => {
  // 1. Discover all skill directories with SKILL.md
  const dirs = fs.readdirSync(rootDir).filter((f) => {
    const fullPath = path.join(rootDir, f);
    return fs.statSync(fullPath).isDirectory() && !f.startsWith('.') && !SKIP_DIRS.has(f);
  });

  const skills = [];
  for (const dir of dirs) {
    const skillMdPath = path.join(rootDir, dir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    const content = fs.readFileSync(skillMdPath, 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm) continue;

    const info = inspectSkillDir(path.join(rootDir, dir));
    const cliCommand = fm.status === 'implemented' ? deriveCLICommand(dir) : '';

    skills.push({
      dir,
      name: fm.name || dir,
      description: fm.description,
      status: fm.status,
      cliCommand,
      ...info,
    });
  }

  // 2. Categorize
  const implemented = skills.filter((s) => s.status === 'implemented');
  const planned = skills.filter((s) => s.status === 'planned');
  const conceptual = skills.filter((s) => s.status === 'conceptual');

  // Sort each group alphabetically
  implemented.sort((a, b) => a.name.localeCompare(b.name));
  planned.sort((a, b) => a.name.localeCompare(b.name));
  conceptual.sort((a, b) => a.name.localeCompare(b.name));

  // 3. Generate markdown catalog
  const timestamp = new Date().toISOString();
  const lines = [];

  lines.push('# Gemini Skills Catalog');
  lines.push('');
  lines.push(`> Auto-generated on ${timestamp}`);
  lines.push('');

  // Summary statistics
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`| ------ | ----- |`);
  lines.push(`| Total Skills | ${skills.length} |`);
  lines.push(`| Implemented | ${implemented.length} |`);
  lines.push(`| Planned | ${planned.length} |`);
  lines.push(`| Conceptual | ${conceptual.length} |`);
  lines.push('');

  // Implemented skills table
  if (implemented.length > 0) {
    lines.push('## Implemented Skills');
    lines.push('');
    lines.push('| Name | Description | CLI Command | TypeScript |');
    lines.push('| ---- | ----------- | ----------- | ---------- |');
    for (const s of implemented) {
      const tsFlag = s.hasTypeScript ? 'Yes' : 'No';
      const cmd = s.cliCommand ? `\`${s.cliCommand}\`` : '-';
      lines.push(`| ${s.name} | ${s.description} | ${cmd} | ${tsFlag} |`);
    }
    lines.push('');
  }

  // Planned skills table
  if (planned.length > 0) {
    lines.push('## Planned Skills');
    lines.push('');
    lines.push('| Name | Description |');
    lines.push('| ---- | ----------- |');
    for (const s of planned) {
      lines.push(`| ${s.name} | ${s.description} |`);
    }
    lines.push('');
  }

  // Conceptual skills table
  if (conceptual.length > 0) {
    lines.push('## Conceptual Skills');
    lines.push('');
    lines.push('| Name | Description |');
    lines.push('| ---- | ----------- |');
    for (const s of conceptual) {
      lines.push(`| ${s.name} | ${s.description} |`);
    }
    lines.push('');
  }

  // 4. Write catalog file
  const outPath = path.resolve(argv.out);
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

  return {
    catalogPath: outPath,
    totalSkills: skills.length,
    implemented: implemented.length,
    planned: planned.length,
    conceptual: conceptual.length,
    skills: skills.map((s) => ({
      name: s.name,
      status: s.status,
      hasTypeScript: s.hasTypeScript,
      hasPackageJson: s.hasPackageJson,
      hasScriptsDir: s.hasScriptsDir,
    })),
  };
});
