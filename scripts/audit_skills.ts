/**
 * scripts/audit_skills.ts
 * Skill Quality Audit
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { logger } from '@agent/core/core';
import { safeReadFile } from '@agent/core';
import * as pathResolver from '@agent/core/path-resolver';

const indexPath = pathResolver.knowledge('orchestration/global_skill_index.json');
const formatJson = process.argv.includes('--format') && process.argv.includes('json');

function loadIndex() {
  const content = safeReadFile(indexPath, { encoding: 'utf8' }) as string;
  return JSON.parse(content);
}

function checkSkill(skillName: string, skillRelPath: string) {
  const skillDir = pathResolver.rootResolve(skillRelPath);
  const checks: any = {
    packageJson: false,
    skillWrapper: false,
    secureIo: false,
    governanceTags: false,
    skillMd: false,
    unitTests: false,
  };

  checks.packageJson = fs.existsSync(path.join(skillDir, 'package.json'));

  const codeDirs = [path.join(skillDir, 'scripts'), path.join(skillDir, 'src')];
  for (const cDir of codeDirs) {
    if (fs.existsSync(cDir)) {
      const files = fs.readdirSync(cDir).filter((f) => /\.(cjs|js|mjs|ts)$/.test(f));
      for (const file of files) {
        try {
          const content = safeReadFile(path.join(cDir, file), { encoding: 'utf8' }) as string;
          if (content.includes('runSkill') || content.includes('runAsyncSkill'))
            checks.skillWrapper = true;
          if (
            content.includes('secure-io') ||
            content.includes('system-prelude') ||
            content.includes('safeWriteFile') ||
            content.includes('safeReadFile')
          )
            checks.secureIo = true;
        } catch (_) {}
      }
    }
  }

  const skillMd = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillMd)) {
    try {
      const content = safeReadFile(skillMd, { encoding: 'utf8' }) as string;
      const hasName = /name:\s*.+$/m.test(content);
      const hasDesc = /description:\s*/m.test(content);
      checks.skillMd = hasName && hasDesc;

      if (skillRelPath.includes('/audit/') || skillRelPath.includes('/business/')) {
        if (
          content.toUpperCase().includes('IPA') ||
          content.toUpperCase().includes('FISC') ||
          content.includes('governance')
        ) {
          checks.governanceTags = true;
        }
      } else {
        checks.governanceTags = true;
      }
    } catch (_) {}
  }

  const testFiles = [
    pathResolver.rootResolve('tests/unit.test.cjs'),
    path.join(skillDir, 'tests/unit.test.cjs'),
    path.join(skillDir, 'src/lib.test.ts'),
    path.join(skillDir, 'src/index.test.ts'),
  ];
  for (const tPath of testFiles) {
    if (fs.existsSync(tPath)) {
      if (tPath.includes('src/')) {
        checks.unitTests = true;
        break;
      }
      try {
        const testContent = safeReadFile(tPath, { encoding: 'utf8' }) as string;
        if (testContent.includes(skillName)) {
          checks.unitTests = true;
          break;
        }
      } catch (_) {}
    }
  }

  checks.score = Object.values(checks).filter((v) => v === true).length;
  checks.maxScore = 6;

  return checks;
}

async function main() {
  const index = loadIndex();
  const skills = index.s || index.skills;
  const implemented = skills.filter(
    (s: any) => (s.s || s.status) === 'impl' || (s.s || s.status) === 'implemented'
  );
  const results: any[] = [];

  for (const skill of implemented) {
    const name = skill.n || skill.name;
    const sPath = skill.path || name;
    const checks = checkSkill(name, sPath);
    results.push({ name, category: sPath.split('/')[1] || 'General', ...checks });
  }

  results.sort((a, b) => a.score - b.score);

  if (formatJson) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } else {
    logger.info(chalk.bold.cyan(`Skill Quality Audit (TS) - ${results.length} implemented skills`));
    console.log('  ' + 'Skill'.padEnd(35) + 'NS'.padEnd(12) + 'Wrapper  SecureIO  SKILL.md  Tests  Score');
    console.log('  ' + '─'.repeat(95));

    for (const r of results) {
      const mark = (v: boolean) => (v ? chalk.green('  Y  ') : chalk.red('  -  '));
      const scoreColor = r.score === r.maxScore ? chalk.green : r.score < 4 ? chalk.red : chalk.yellow;

      console.log(
        '  ' +
          r.name.padEnd(35) +
          r.category.padEnd(12) +
          mark(r.skillWrapper) +
          mark(r.secureIo) +
          mark(r.skillMd) +
          mark(r.unitTests) +
          '  ' +
          scoreColor(`${r.score}/${r.maxScore}`)
      );
    }

    const avg = Math.round((results.reduce((s, r) => s + r.score, 0) / results.length) * 10) / 10;
    const perfect = results.filter((r) => r.score === r.maxScore).length;
    console.log('\n  ' + '─'.repeat(95));
    logger.info(`Average Score: ${avg}/6  |  Perfect (6/6): ${perfect}  |  Critical Focus (<4): ${results.filter((r) => r.score < 4).length}`);
  }
}

if (require.main === module) {
  main().catch(err => {
    logger.error(`Audit Failed: ${err.message}`);
    process.exit(1);
  });
}
