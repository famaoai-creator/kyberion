const fs = require('fs');
const path = require('path');
const { logger, fileUtils, errorHandler } = require('../libs/core/core.cjs');

/**
 * Global Skill Index Generator
 * Scans all directories for SKILL.md and creates a compact JSON index.
 */

const rootDir = path.resolve(__dirname, '..');
const indexFile = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');

try {
  const skills = [];
  const skillsRootDir = path.join(rootDir, 'skills');
  const categories = fs
    .readdirSync(skillsRootDir)
    .filter((f) => fs.lstatSync(path.join(skillsRootDir, f)).isDirectory());

  // Pre-compile regex for performance
  const descRegex = /^description:\s*(.*)$/m;
  const statusRegex = /^status:\s*(\w+)$/m;
  const riskRegex = /^risk_level:\s*(\w+)$/m;

  for (const cat of categories) {
    const catPath = path.join(skillsRootDir, cat);
    const skillDirs = fs.readdirSync(catPath).filter((f) => {
      const fullPath = path.join(catPath, f);
      return fs.statSync(fullPath).isDirectory(); // statSync follows links by default
    });

    for (const dir of skillDirs) {
      const skillPhysicalPath = path.join('skills', cat, dir);
      const skillFullDir = path.join(rootDir, skillPhysicalPath);
      const skillPath = path.join(skillFullDir, 'SKILL.md');

      if (fs.existsSync(skillPath)) {
        const content = fs.readFileSync(skillPath, 'utf8');
        const descMatch = content.match(descRegex);
        const statusMatch = content.match(statusRegex);
        const riskMatch = content.match(riskRegex);

        // Performance: Truncate description to 100 chars for compact index
        let desc = descMatch ? descMatch[1].trim() : '';
        if (desc.length > 100) desc = desc.substring(0, 97) + '...';

        // Get main script and tags from package.json/SKILL.md
        const pkgPath = path.join(skillFullDir, 'package.json');
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
          path: skillPhysicalPath, // Physical path in hierarchical structure
          d: desc, // Compressed key: description
          s: statusMatch
            ? statusMatch[1] === 'implemented'
              ? 'impl'
              : statusMatch[1].substring(0, 4)
            : 'plan',
          r: riskMatch ? riskMatch[1] : 'low', // NEW: risk_level
          m: mainScript, // Compressed key: main script path
          t: tags, // Compressed key: tags
        });
      }
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
