const fs = require('fs');
const path = require('path');
const { logger, fileUtils, errorHandler } = require('./lib/core.cjs');

/**
 * Global Skill Index Generator
 * Scans all directories for SKILL.md and creates a compact JSON index.
 */

const rootDir = path.resolve(__dirname, '..');
const indexFile = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');

try {
  const skills = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });

  // Pre-compile regex for performance
  const descRegex = /^description:\s*(.*)$/m;
  const statusRegex = /^status:\s*(\w+)$/m;

  const dirs = entries
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith('.') &&
        ![
          'node_modules',
          'knowledge',
          'scripts',
          'evidence',
          'work',
          'templates',
          'schemas',
          'nonfunctional',
          'pipelines',
          'plugins',
        ].includes(e.name)
    )
    .map((e) => e.name);

  for (const dir of dirs) {
    const skillPath = path.join(rootDir, dir, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const content = fs.readFileSync(skillPath, 'utf8');
      const descMatch = content.match(descRegex);
      const statusMatch = content.match(statusRegex);

      // Performance: Truncate description to 100 chars for compact index
      let desc = descMatch ? descMatch[1].trim() : '';
      if (desc.length > 100) desc = desc.substring(0, 97) + '...';

      // Get main script and tags from package.json/SKILL.md
      const pkgPath = path.join(rootDir, dir, 'package.json');
      let mainScript = '';
      let tags = [];

      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          mainScript = pkg.main || '';
        } catch (_) {}
      }

      // Extract tags from frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        try {
          const yaml = require('js-yaml');
          const fm = yaml.load(fmMatch[1]);
          tags = fm.tags || [];
        } catch (_) {}
      }

      skills.push({
        n: dir, // Compressed key: name
        d: desc, // Compressed key: description
        s: statusMatch ? statusMatch[1].substring(0, 4) : 'plan', // status: impl/plan/conc
        m: mainScript, // Compressed key: main script path
        t: tags, // Compressed key: tags
      });
    }
  }

  fileUtils.writeJson(indexFile, {
    v: '1.1.0', // Version
    t: skills.length, // total
    u: new Date().toISOString(), // updated
    s: skills, // skills
  });

  logger.success(`Global Skill Index generated with ${skills.length} skills at ${indexFile}`);
} catch (err) {
  errorHandler(err, 'Skill Index Generation Failed');
}
