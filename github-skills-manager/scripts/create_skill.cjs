const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const skillName = process.argv[2];
if (!skillName) {
    console.error("Error: Please provide a skill name.");
    process.exit(1);
}

// Ensure we are in the monorepo root (simple check: look for .git)
if (!fs.existsSync('.git')) {
    console.warn("Warning: Current directory does not appear to be a git repository root.");
}

const skillCreatorPath = '/opt/homebrew/Cellar/gemini-cli/0.26.0/libexec/lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/skills/builtin/skill-creator/scripts/init_skill.cjs';

try {
    console.log(`Creating new skill '${skillName}' in current directory...`);
    execSync(`node "${skillCreatorPath}" "${skillName}" --path .`, { stdio: 'inherit' });
    console.log(`\n✅ Skill '${skillName}' created successfully!`);
    console.log(`\nNext steps:`);
    console.log(`1. Edit ${skillName}/SKILL.md to define your skill.`);
    console.log(`2. Run 'gemini skills install ${skillName}/SKILL.md' (if supported) or package it.`);
} catch (error) {
    console.error("Failed to create skill:", error.message);
    process.exit(1);
}

