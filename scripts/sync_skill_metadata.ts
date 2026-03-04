/**
 * scripts/sync_skill_metadata.ts
 * Synchronizes code (yargs), SKILL.md (SoT), and package.json (npm).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import chalk from 'chalk';
import { logger, safeReadFile, safeWriteFile } from '@agent/core';
import * as pathResolver from '@agent/core/path-resolver';

const skillsRootDir = pathResolver.rootResolve('skills');

function extractArgsFromCode(scriptPath: string) {
  if (!fs.existsSync(scriptPath)) return [];
  try {
    const content = safeReadFile(scriptPath, { encoding: 'utf8' }) as string;
    const args: any[] = [];
    const optionRegex = /\.option\(['"]([^'"]+)['"],\s*\{([\s\S]*?)\}\)/g;
    let match;

    while ((match = optionRegex.exec(content)) !== null) {
      const body = match[2];
      const arg: any = { name: match[1] };
      const aliasMatch = body.match(/alias:\s*['"]([^'"]+)['"]/);
      const typeMatch = body.match(/type:\s*['"]([^'"]+)['"]/);
      const demandMatch = body.match(/demandOption:\s*true/);
      const descMatch = body.match(/desc(?:ribe|ription)?:\s*['"]([^'"]+)['"]/);

      if (aliasMatch) arg.short = aliasMatch[1];
      if (typeMatch) arg.type = typeMatch[1];
      if (demandMatch) arg.required = true;
      if (descMatch) arg.description = descMatch[1];
      args.push(arg);
    }
    return args;
  } catch (_) {
    return [];
  }
}

function syncSkill(cat: string, dir: string) {
  const skillFullDir = path.join(skillsRootDir, cat, dir);
  const skillMdPath = path.join(skillFullDir, 'SKILL.md');
  const pkgPath = path.join(skillFullDir, 'package.json');
  const srcDir = path.join(skillFullDir, 'src');

  if (!fs.existsSync(skillMdPath)) return;

  try {
    let mainScript = path.join(srcDir, 'index.ts');
    if (!fs.existsSync(mainScript) && fs.existsSync(srcDir)) {
      const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
      if (files.length > 0) mainScript = path.join(srcDir, files[0]);
    }

    const codeArgs = extractArgsFromCode(mainScript);
    const originalContent = safeReadFile(skillMdPath, { encoding: 'utf8' }) as string;
    const fmMatch = originalContent.match(/^---\n([\s\S]*?)\n---/m);

    if (fmMatch) {
      const fm: any = yaml.load(fmMatch[1]);
      if (codeArgs.length > 0) fm.arguments = codeArgs;
      fm.category = cat.charAt(0).toUpperCase() + cat.slice(1);
      fm.last_updated = new Date().toISOString().split('T')[0];

      const newFm = `---\n${yaml.dump(fm)}---`;
      const newMdContent = originalContent.replace(/^---\n[\s\S]*?\n---/m, newFm);

      if (newMdContent !== originalContent) {
        safeWriteFile(skillMdPath, newMdContent);
        logger.info(`  [${dir}] Updated SKILL.md`);
      }

      if (fs.existsSync(pkgPath)) {
        const pkgContent = safeReadFile(pkgPath, { encoding: 'utf8' }) as string;
        const pkg = JSON.parse(pkgContent);
        if (pkg.description !== fm.description) {
          pkg.description = fm.description;
          safeWriteFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
          logger.info(`  [${dir}] Updated package.json description`);
        }
      }
    }
  } catch (err: any) {
    logger.error(`  [${dir}] Sync failed: ${err.message}`);
  }
}

async function main() {
  logger.info('🔄 Synchronizing Ecosystem Metadata...');
  const categories = fs.readdirSync(skillsRootDir).filter((f) => fs.lstatSync(path.join(skillsRootDir, f)).isDirectory());
  categories.forEach((cat) => {
    const catPath = path.join(skillsRootDir, cat);
    const skillDirs = fs.readdirSync(catPath).filter((f) => fs.lstatSync(path.join(catPath, f)).isDirectory());
    skillDirs.forEach((dir) => syncSkill(cat, dir));
  });
  logger.success('✨ All skill metadata is now consistent across MD, JS, and JSON.');
}

if (require.main === module) {
  main().catch(err => {
    logger.error(`Metadata Sync Failed: ${err.message}`);
    process.exit(1);
  });
}
