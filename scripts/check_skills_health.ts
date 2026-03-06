import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { safeWriteFile } from '@agent/core';

const currentPlatform = os.platform();

interface SkillObj {
  name: string;
  path: string;
}

interface PackageJson {
  name?: string;
  main?: string;
  author?: string;
  license?: string;
  private?: boolean;
  devDependencies?: Record<string, string>;
  [key: string]: any;
}

const rootDir = process.cwd();
const argv = yargs(hideBin(process.argv))
  .option('fix', {
    alias: 'f',
    type: 'boolean',
    default: false,
    describe: 'Automatically fix repairable issues',
  })
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    default: false,
    describe: 'Show detailed health info',
  })
  .help('help')
  .alias('h', 'help').parseSync();

let issues = 0;
let fixed = 0;

// Dynamically discover skills within namespaces
const skills: SkillObj[] = [];
const skillsRootDir = path.join(rootDir, 'skills');

if (fs.existsSync(skillsRootDir)) {
  const categories = fs
    .readdirSync(skillsRootDir)
    .filter((f) => fs.lstatSync(path.join(skillsRootDir, f)).isDirectory());
  
  for (const cat of categories) {
    const catPath = path.join(skillsRootDir, cat);
    const skillDirs = fs
      .readdirSync(catPath)
      .filter((f) => fs.lstatSync(path.join(catPath, f)).isDirectory());
    
    for (const dir of skillDirs) {
      skills.push({ name: dir, path: path.join('skills', cat, dir) });
    }
  }
}

console.log(
  `=== Checking Health for ${skills.length} Skills${argv.fix ? ' (Auto-Fix Enabled)' : ''} ===
`
);

skills.forEach((skillObj) => {
  const skill = skillObj.name;
  const skillPath = path.join(rootDir, skillObj.path);
  let status = '✅ OK';
  const details: string[] = [];
  let needsFix = false;

  const pkgPath = path.join(skillPath, 'package.json');
  const skillMdPath = path.join(skillPath, 'SKILL.md');
  let isPlanned = false;

  // Check SKILL.md for status and platform
  if (fs.existsSync(skillMdPath)) {
    const mdContent = fs.readFileSync(skillMdPath, 'utf8');
    const fmMatch = mdContent.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      try {
        const fm: any = yaml.load(fmMatch[1]);
        if (fm.status === 'planned') {
          isPlanned = true;
          status = '⏳ PLANNED';
          details.push('Pending implementation');
        }
        if (fm.platforms && Array.isArray(fm.platforms) && fm.platforms.length > 0) {
          if (!fm.platforms.includes(currentPlatform)) {
            status = '🚫 UNSUPPORTED';
            details.push(`OS mismatch (Current: ${currentPlatform}, Required: ${fm.platforms.join(', ')})`);
          }
        }
      } catch (_) {}
    } else if (mdContent.includes('status: planned')) {
      isPlanned = true;
      status = '⏳ PLANNED';
      details.push('Pending implementation');
    }
  }

  if (fs.existsSync(pkgPath)) {
    try {
      const pkg: PackageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      let mainScript = pkg.main ? path.join(skillPath, pkg.main) : null;

      // 1. Standard Fields Check
      if (pkg.author !== 'Gemini Agent' || pkg.license !== 'MIT' || pkg.private !== true) {
        if (!isPlanned) details.push('Invalid metadata');
        if (argv.fix) {
          pkg.author = 'Gemini Agent';
          pkg.license = 'MIT';
          pkg.private = true;
          needsFix = true;
        }
      }

      // 2. Dependency Check (@agent/core)
      if (!pkg.devDependencies || !pkg.devDependencies['@agent/core']) {
        if (!isPlanned) details.push('Missing @agent/core devDep');
        if (argv.fix) {
          if (!pkg.devDependencies) pkg.devDependencies = {};
          pkg.devDependencies['@agent/core'] = 'workspace:*';
          needsFix = true;
        }
      }

      // 3. Main Script Check & Auto-Detection
      const srcDir = path.join(skillPath, 'src');
      const isTsSkill = fs.existsSync(srcDir);

      if (!mainScript || !fs.existsSync(mainScript)) {
        if (isPlanned) {
          status = '⏳ PLANNED';
          details.push('Pending implementation');
        } else {
          details.push(`Broken main: ${pkg.main || 'none'}`);
          if (argv.fix) {
            const scriptsDir = path.join(skillPath, 'scripts');
            const distDir = path.join(skillPath, 'dist');
            const candidates: string[] = [];

            if (isTsSkill) {
              if (fs.existsSync(distDir)) {
                const distFiles = fs.readdirSync(distDir, { recursive: true } as any)
                  .filter((f: any) => f.endsWith('.js') || f.endsWith('.cjs'))
                  .map((f: any) => `dist/${f}`);
                
                const bestDist = distFiles.find((f: string) => f.includes('index.js') || f.includes('main.js')) || distFiles[0];
                if (bestDist) candidates.push(bestDist);
              }
            } else {
              if (fs.existsSync(scriptsDir)) {
                const scriptFiles = fs.readdirSync(scriptsDir)
                  .filter((f) => f.endsWith('.cjs') || f.endsWith('.js'))
                  .map((f) => `scripts/${f}`);
                
                const bestScript = scriptFiles.find((f) => f.includes('index.js') || f.includes('main.js')) || scriptFiles[0];
                if (bestScript) candidates.push(bestScript);
              }
            }

            const bestMatch = candidates[0];
            if (bestMatch) {
              pkg.main = bestMatch;
              mainScript = path.join(skillPath, pkg.main);
              needsFix = true;
              details.push(`(Fixed to ${pkg.main})`);
            }
          }
          if (!needsFix) {
            status = '❌ BROKEN';
            issues++;
          }
        }
      }

      // 4. Legacy Import Check
      if (mainScript && fs.existsSync(mainScript)) {
        const scriptContent = fs.readFileSync(mainScript, 'utf8');
        if (scriptContent.includes('../../scripts/lib/')) {
          details.push('Legacy imports found');
          status = '⚠️  LEGACY';
        }
      }

      // 5. Syntax Check
      if (mainScript && fs.existsSync(mainScript)) {
        try {
          execSync(`node -c "${mainScript}"`, { stdio: 'ignore' });
        } catch (_e) {
          details.push('Syntax Error');
          status = '❌ ERROR';
          issues++;
        }
      }

      if (needsFix && argv.fix) {
        safeWriteFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
        fixed++;
      }
    } catch (_e) {
      details.push('Invalid package.json');
      status = '❌ INVALID';
      issues++;
    }
  } else {
    details.push('No package.json');
    status = '⚠️  CONFIG';
    issues++;
  }

  if (details.length > 0) {
    if (status === '✅ OK') status = argv.fix ? '🔧 FIXED' : '⚠️  WARN';
    console.log(`[${skill.padEnd(25)}] ${status} ${details.join(', ')}`);
  }
});

console.log(`
Total Issues: ${issues}`);
if (argv.fix) console.log(`Total Fixed:  ${fixed}`);
if (issues > 0) process.exit(1);
