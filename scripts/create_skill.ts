/**
 * scripts/create_skill.ts
 * Scaffolds a new Gemini skill with complete standard boilerplate.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, safeWriteFile } from '@agent/core';

const ROOT_DIR = process.cwd();

function scaffoldSkill(category: string, name: string) {
  const skillDir = path.join(ROOT_DIR, 'skills', category, name);

  if (fs.existsSync(skillDir)) {
    logger.error(`Skill directory already exists: ${skillDir}`);
    process.exit(1);
  }

  fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });

  // 1. package.json
  const pkg = {
    name: `@agent/skill-${name}`,
    version: '1.0.0',
    private: true,
    description: `A Gemini Skill for ${name}`,
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    scripts: {
      "build": "tsc",
      "test": "vitest run"
    },
    dependencies: {
      "@agent/core": "workspace:*"
    }
  };
  safeWriteFile(path.join(skillDir, 'package.json'), JSON.stringify(pkg, null, 2));

  // 2. tsconfig.json
  const tsconfig = {
    extends: "../../../tsconfig.json",
    compilerOptions: {
      outDir: "./dist",
      rootDir: "./src"
    },
    include: ["src/**/*"]
  };
  safeWriteFile(path.join(skillDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

  // 3. SKILL.md
  const md = `---
name: ${name}
description: A new Gemini skill for ${name}.
status: planned
category: ${category.charAt(0).toUpperCase() + category.slice(1)}
last_updated: '${new Date().toISOString().split('T')[0]}'
---

# ${name}

## 📋 Role & Responsibility
(Describe what this skill does)

## 🛠️ Usage
\`\`\`bash
npm run cli -- ${name}
\`\`\`
`;
  safeWriteFile(path.join(skillDir, 'SKILL.md'), md);

  // 4. src/lib.ts
  const lib = `import { logger } from '@agent/core';\n\nexport function executeLogic() {\n  logger.info('Executing ${name} logic...');\n  return { success: true };\n}\n`;
  safeWriteFile(path.join(skillDir, 'src/lib.ts'), lib);

  // 5. src/index.ts
  const index = `import { runSkill } from '@agent/core';\nimport { executeLogic } from './lib.js';\n\nasync function main(args: any) {\n  return executeLogic();\n}\n\nrunSkill(main);\n`;
  safeWriteFile(path.join(skillDir, 'src/index.ts'), index);

  logger.success(`✨ Successfully scaffolded new skill: ${category}/${name}`);
  logger.info(`Run 'npm run build' from the root to compile it.`);
}

const cat = process.argv[2];
const nom = process.argv[3];

if (!cat || !nom) {
  console.log('Usage: npx tsx scripts/create_skill.ts <category> <skill-name>');
  process.exit(1);
}

scaffoldSkill(cat, nom);
