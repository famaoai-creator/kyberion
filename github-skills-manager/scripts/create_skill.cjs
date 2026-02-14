const { execSync } = require('child_process');
const fs = require('fs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');

const skillName = process.argv[2];
if (!skillName) {
  console.error('Error: Please provide a skill name.');
  process.exit(1);
}

// Ensure we are in the monorepo root (simple check: look for .git)
if (!fs.existsSync('.git')) {
  console.warn('Warning: Current directory does not appear to be a git repository root.');
}

const skillCreatorPath =
  '/opt/homebrew/Cellar/gemini-cli/0.26.0/libexec/lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/skills/builtin/skill-creator/scripts/init_skill.cjs';

runSkill('github-skills-manager', () => {
  execSync(`node "${skillCreatorPath}" "${skillName}" --path .`, { stdio: 'inherit' });

  return { skillName, created: true };
});
