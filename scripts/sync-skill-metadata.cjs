const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '../skills');

function getCategories() {
  return fs.readdirSync(SKILLS_DIR).filter((f) => {
    const p = path.join(SKILLS_DIR, f);
    return fs.statSync(p).isDirectory() && f !== 'core';
  });
}

function syncSkill(category, name) {
  const skillPath = path.join(SKILLS_DIR, category, name);
  const pkgPath = path.join(skillPath, 'package.json');
  const skillMdPath = path.join(skillPath, 'SKILL.md');
  const indexPath = path.join(skillPath, 'src/index.ts');

  if (!fs.existsSync(pkgPath) || !fs.existsSync(skillMdPath)) return;

  console.log(`[Sync] Processing ${category}/${name}...`);

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  let skillMd = fs.readFileSync(skillMdPath, 'utf8');

  // 1. Sync Description
  const descPattern = /description: >-?\n([\s\S]*?)status:/;
  const newDesc = `  ${pkg.description || ''}\n`;
  if (descPattern.test(skillMd)) {
    skillMd = skillMd.replace(descPattern, `description: >-\n${newDesc}status:`);
  }

  // 2. Sync Arguments from src/index.ts
  if (fs.existsSync(indexPath)) {
    const indexContent = fs.readFileSync(indexPath, 'utf8');
    // Regex to match .option('name', { alias: 'n', type: 'string', description: 'desc' })
    const optRegex = /\.option\(\s*'([^']+)',\s*{([\s\S]*?)}\s*\)/g;
    const args = [];
    let match;
    while ((match = optRegex.exec(indexContent)) !== null) {
      const argName = match[1];
      const optBody = match[2];

      const aliasMatch = optBody.match(/alias:\s*'([^']+)'/);
      const typeMatch = optBody.match(/type:\s*'([^']+)'/);
      const descMatch = optBody.match(/description:\s*'([^']+)'/);
      const demandMatch = optBody.match(/demandOption:\s*true/);

      args.push({
        name: argName,
        short: aliasMatch ? aliasMatch[1] : undefined,
        type: typeMatch ? typeMatch[1] : 'string',
        required: !!demandMatch,
        description: descMatch ? descMatch[2] : '',
      });
    }

    if (args.length > 0) {
      const argsYaml = args
        .map((a) => {
          let lines = [`  - name: ${a.name}`];
          if (a.short) lines.push(`    short: ${a.short}`);
          lines.push(`    type: ${a.type}`);
          lines.push(`    required: ${a.required}`);
          lines.push(`    description: ${a.description}`);
          return lines.join('\n');
        })
        .join('\n');

      const argsPattern = /arguments:\n([\s\S]*?)category:/;
      if (argsPattern.test(skillMd)) {
        skillMd = skillMd.replace(argsPattern, `arguments:\n${argsYaml}\ncategory:`);
      }
    }
  }

  fs.writeFileSync(skillMdPath, skillMd);
  console.log(`  Updated metadata and arguments.`);
}

const categories = getCategories();
categories.forEach((cat) => {
  const catPath = path.join(SKILLS_DIR, cat);
  const skills = fs
    .readdirSync(catPath)
    .filter((f) => fs.statSync(path.join(catPath, f)).isDirectory());
  skills.forEach((skill) => syncSkill(cat, skill));
});

console.log('[Sync] Complete.');
