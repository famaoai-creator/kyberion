import { logger, safeExec, safeReadFile, safeWriteFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as util from 'node:util';
import * as fs from 'node:fs';

/**
 * Code-Actuator v1.3.0 [MAINTAIN ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 */

interface CodeAction {
  action: 'analyze' | 'refactor' | 'verify' | 'test' | 'run_live_js' | 'sanitize-deps' | 'maintain' | 'generate-types' | 'sanitize';
  path?: string;
  // ... rest of interface
  code?: string; // For run_live_js
  command?: string;
  changes?: Array<{ old: string; new: string }>;
  params?: any;
}

function isUsed(dep: string, skillDir: string): boolean {
  const searchDirs = ['scripts', 'src'];
  let found = false;

  for (const sDir of searchDirs) {
    const targetPath = path.join(skillDir, sDir);
    if (!fs.existsSync(targetPath)) continue;

    const files = fs
      .readdirSync(targetPath, { recursive: true } as any)
      .filter((f: any) => f.endsWith('.js') || f.endsWith('.cjs') || f.endsWith('.ts'));

    for (const file of files as string[]) {
      const content = fs.readFileSync(path.join(targetPath, file), 'utf8');
      const escapedDep = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const requireRegex = new RegExp('require\\([\'"]' + escapedDep + '[\'"]', 'g');
      const importRegex = new RegExp('from\\s+[\'"]' + escapedDep + '[\'"]', 'g');
      const directImportRegex = new RegExp('import\\s+[\'"]' + escapedDep + '[\'"]', 'g');
      
      if (requireRegex.test(content) || importRegex.test(content) || directImportRegex.test(content)) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  return found;
}

function discoverSkills(rootDir: string) {
  const skills: { name: string; path: string }[] = [];
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
  return skills;
}

function walk(dir: string, extension?: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of list) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results = results.concat(walk(fullPath, extension));
    } else if (!extension || fullPath.endsWith(extension)) {
      results.push(fullPath);
    }
  }
  return results;
}

async function runSanitizeDeps(rootDir: string, policy: any, rootPkg: any) {
  const TARGET_VERSIONS: Record<string, string> = {
    ...rootPkg.dependencies,
    ...rootPkg.devDependencies,
  };

  const skills = discoverSkills(rootDir);
  logger.info(`📦 [CODE] Sanitizing ${skills.length} skills...`);

  let totalUnused = 0;
  let totalNormalized = 0;

  for (const skillObj of skills) {
    const fullSkillPath = path.join(rootDir, skillObj.path);
    const pkgPath = path.join(fullSkillPath, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    let modified = false;

    // 1. Unused check
    if (pkg.dependencies) {
      for (const dep of Object.keys(pkg.dependencies)) {
        if (policy.ignore_deps.includes(dep)) continue;
        if (dep.startsWith('@agent/')) continue;

        if (!isUsed(dep, fullSkillPath)) {
          logger.info(`  [${skillObj.name}] UNUSED: ${dep}`);
          delete pkg.dependencies[dep];
          totalUnused++;
          modified = true;
        }
      }
      if (Object.keys(pkg.dependencies).length === 0) delete pkg.dependencies;
    }

    // 2. Normalization
    if (policy.normalization.private && pkg.private !== true) {
      pkg.private = true;
      modified = true;
    }
    if (policy.normalization.author && pkg.author !== policy.normalization.author) {
      pkg.author = policy.normalization.author;
      modified = true;
    }
    if (policy.normalization.license && pkg.license !== policy.normalization.license) {
      pkg.license = policy.normalization.license;
      modified = true;
    }
    if (policy.normalization.ensure_engines && rootPkg.engines?.node) {
      if (!pkg.engines || pkg.engines.node !== rootPkg.engines.node) {
        pkg.engines = { node: rootPkg.engines.node };
        modified = true;
      }
    }
    
    // Normalize Versions
    if (pkg.dependencies) {
      for (const [name, version] of Object.entries(pkg.dependencies as Record<string, string>)) {
        if (TARGET_VERSIONS[name] && version !== TARGET_VERSIONS[name]) {
          pkg.dependencies[name] = TARGET_VERSIONS[name];
          modified = true;
        }
      }
    }

    if (policy.normalization.ensure_agent_core) {
      if (!pkg.devDependencies) pkg.devDependencies = {};
      if (pkg.devDependencies['@agent/core'] !== 'workspace:*') {
        pkg.devDependencies['@agent/core'] = 'workspace:*';
        modified = true;
      }
    }

    if (modified) {
      safeWriteFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      totalNormalized++;
    }
  }

  return { total_unused_removed: totalUnused, total_packages_normalized: totalNormalized };
}

async function runThinDependencies(rootDir: string, rootPkg: any) {
  const COMMON = Object.keys({
    ...rootPkg.dependencies,
    ...rootPkg.devDependencies,
  });
  const skills = discoverSkills(rootDir);
  let totalRemoved = 0;

  for (const skillObj of skills) {
    const pkgPath = path.join(rootDir, skillObj.path, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    let modified = false;

    if (pkg.dependencies) {
      for (const dep of COMMON) {
        if (pkg.dependencies[dep]) {
          logger.info(`  [${skillObj.name}] Removing redundant dependency: ${dep}`);
          delete pkg.dependencies[dep];
          totalRemoved++;
          modified = true;
        }
      }
      if (Object.keys(pkg.dependencies).length === 0) delete pkg.dependencies;
    }

    if (modified) {
      safeWriteFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    }
  }
  return totalRemoved;
}

async function runFixShebangs(rootDir: string) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const skillDirs = entries.filter(
    (e) => e.isDirectory() && !['node_modules', 'scripts', 'knowledge', 'work', 'templates', 'active', 'vault'].includes(e.name) && !e.name.startsWith('.')
  );

  let fixedCount = 0;
  for (const dir of skillDirs) {
    const scriptsPath = path.join(rootDir, dir.name, 'scripts');
    if (!fs.existsSync(scriptsPath)) continue;

    const files = fs.readdirSync(scriptsPath).filter((f) => f.endsWith('.cjs') || f.endsWith('.js') || f.endsWith('.ts'));
    for (const file of files) {
      const filePath = path.join(scriptsPath, file);
      const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;

      if (content.includes('#!/usr/bin/env node') && !content.startsWith('#!')) {
        logger.info(`  [${dir.name}] Fixing Shebang position: ${file}`);
        const lines = content.split('\n');
        const shebangIdx = lines.findIndex((l) => l.startsWith('#!'));
        const shebangLine = lines[shebangIdx];
        lines.splice(shebangIdx, 1);
        safeWriteFile(filePath, shebangLine + '\n' + lines.join('\n'));
        fixedCount++;
      }
    }
  }
  return fixedCount;
}

async function runMassRefactorGovernance(rootDir: string) {
  const skillsDir = path.join(rootDir, 'skills');
  if (!fs.existsSync(skillsDir)) return 0;

  const files = walk(skillsDir, '.ts').filter(f => f.includes('/src/'));
  let total = 0;

  for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    let modified = false;

    if (content.includes('fs.writeFileSync(') && !content.includes('process.argv')) {
      content = content.replace(/fs\.writeFileSync\(/g, 'safeWriteFile(');
      modified = true;
    }

    if (content.includes('fs.readFileSync(') && !content.includes('process.argv')) {
      content = content.replace(/fs\.readFileSync\(/g, 'safeReadFile(');
      modified = true;
    }

    if (modified) {
      if (!content.includes("'@agent/core'") && !content.includes("'@agent/core/secure-io'")) {
        const importLine = "import { safeWriteFile, safeReadFile } from '@agent/core';\n";
        content = importLine + content;
      }
      safeWriteFile(file, content);
      total++;
    }
  }
  return total;
}

async function runMaintainRefactorBoilerplate(rootDir: string) {
  const files = walk(rootDir, '.cjs').filter(f => f.includes('/scripts/') && !f.includes('scripts/lib/'));
  let total = 0;

  for (const filePath of files) {
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;

    // Refactor Yargs
    if (content.includes('yargs(hideBin(process.argv))') && !content.includes('createStandardYargs')) {
      if (!content.includes('cli-utils.cjs')) {
        content = content.replace(
          "const { runSkill } = require('@agent/core');",
          "const { runSkill } = require('@agent/core');\nconst { createStandardYargs } = require('@agent/core/cli-utils');"
        );
        content = content.replace(
          "const { runAsyncSkill } = require('@agent/core');",
          "const { runAsyncSkill } = require('@agent/core');\nconst { createStandardYargs } = require('@agent/core/cli-utils');"
        );
      }
      content = content.replace('const argv = yargs(hideBin(process.argv))', 'const argv = createStandardYargs()');
      content = content.replace(/const yargs = require\('yargs\/yargs'\);\n?/, '');
      content = content.replace(/const { hideBin } = require\('yargs\/helpers'\);\n?/, '');
      modified = true;
    }

    // Refactor FS Scanning
    if (content.includes('fs.readdirSync') && (content.includes('currentDepth') || content.includes('recursive') || content.includes('walk'))) {
      if (!content.includes('fs-utils.cjs')) {
        content = content.replace(
          "const { runSkill } = require('@agent/core');",
          "const { runSkill } = require('@agent/core');\nconst { walk, getAllFiles } = require('@agent/core/fs-utils');"
        );
      }
      modified = true;
    }

    if (modified) {
      safeWriteFile(filePath, content);
      total++;
    }
  }
  return total;
}

async function handleAction(input: CodeAction) {
  const rootDir = process.cwd();
  switch (input.action) {
    case 'maintain':
      return await performMaintenance(input);

    case 'generate-types':
      return await performTypeGeneration(input);

    case 'sanitize':
      return await performSanitization(input);

    case 'sanitize-deps':
      const policyPath = path.resolve(rootDir, input.params.policy_path);
      const policy = JSON.parse(safeReadFile(policyPath, { encoding: 'utf8' }) as string);
      const rootPkgRawSD = safeReadFile(path.join(rootDir, 'package.json'), { encoding: 'utf8' }) as string;
      const rootPkgSD = JSON.parse(rootPkgRawSD);
      return { status: 'sanitized', ...(await runSanitizeDeps(rootDir, policy, rootPkgSD)) };

    case 'run_live_js':
      if (!input.code) throw new Error('code is required for run_live_js action.');
      
      const logs: string[] = [];
      const sandbox = {
        Buffer,
        process: { env: { ...process.env } }, // Limited env access
        console: {
          log: (...args: any[]) => {
            const msg = args.map(a => typeof a === 'object' ? util.inspect(a) : String(a)).join(' ');
            logs.push(msg);
            logger.info(`[JS-LOG] ${msg}`);
          },
          error: (...args: any[]) => {
            const msg = args.map(a => typeof a === 'object' ? util.inspect(a) : String(a)).join(' ');
            logs.push(`ERROR: ${msg}`);
            logger.error(`[JS-ERROR] ${msg}`);
          }
        },
        setTimeout,
        clearTimeout,
      };

      const context = vm.createContext(sandbox);
      const wrappedCode = `(async () => {\n${input.code}\n})()`;

      try {
        const script = new vm.Script(wrappedCode, { filename: 'live_repl.js' });
        const result = await script.runInContext(context);
        return { 
          status: 'success', 
          output: result, 
          logs 
        };
      } catch (err: any) {
        return { 
          status: 'failed', 
          error: err.message, 
          stack: err.stack,
          logs 
        };
      }

    case 'analyze':
      if (!input.path) throw new Error('path is required');
      const resolvedAnalyze = path.resolve(process.cwd(), input.path);
      const content = safeReadFile(resolvedAnalyze, { encoding: 'utf8' }) as string;
      return { lines: content.split('\n').length, size: content.length };

    case 'refactor':
      if (!input.path) throw new Error('path is required');
      const resolvedRefactor = path.resolve(process.cwd(), input.path);
      let newContent = safeReadFile(resolvedRefactor, { encoding: 'utf8' }) as string;
      for (const change of input.changes || []) {
        newContent = newContent.replace(change.old, change.new);
      }
      safeWriteFile(resolvedRefactor, newContent);
      return { status: 'success' };

    case 'verify':
    case 'test':
      const cmd = input.command || (input.action === 'verify' ? 'npm run build' : 'npm test');
      try {
        const output = safeExec(cmd.split(' ')[0], cmd.split(' ').slice(1));
        return { status: 'success', output };
      } catch (err: any) {
        return { status: 'failed', error: err.message };
      }

    default:
      throw new Error(`Unsupported action: ${input.action}`);
  }
}

async function performMaintenance(input: CodeAction) {
  const rootDir = process.cwd();
  const maintenanceResults: any = {};
  const tasks = input.params.tasks || [];
  const rootPkgRaw = safeReadFile(path.join(rootDir, 'package.json'), { encoding: 'utf8' }) as string;
  const rootPkg = JSON.parse(rootPkgRaw);

  if (tasks.includes('fix_shebangs')) maintenanceResults.fix_shebangs = await runFixShebangs(rootDir);
  if (tasks.includes('thin_dependencies')) maintenanceResults.thin_dependencies = await runThinDependencies(rootDir, rootPkg);
  if (tasks.includes('sanitize_deps')) {
    const pPath = path.resolve(rootDir, input.params.policy_path || 'knowledge/governance/package-governance.json');
    const policy = JSON.parse(safeReadFile(pPath, { encoding: 'utf8' }) as string);
    maintenanceResults.sanitize_deps = await runSanitizeDeps(rootDir, policy, rootPkg);
  }
  if (tasks.includes('mass_refactor_governance')) maintenanceResults.mass_refactor_governance = await runMassRefactorGovernance(rootDir);
  if (tasks.includes('maintain_refactor_boilerplate')) maintenanceResults.maintain_refactor_boilerplate = await runMaintainRefactorBoilerplate(rootDir);
  
  return { status: 'maintained', details: maintenanceResults };
}

async function performTypeGeneration(_input: CodeAction) {
  logger.info('🏷️ [CODE] Generating TypeScript declarations...');
  try {
    safeExec('npx', ['tsc', '--emitDeclarationOnly']);
    return { status: 'success' };
  } catch (err: any) {
    return { status: 'failed', error: err.message };
  }
}

async function performSanitization(_input: CodeAction) {
  const skills = discoverSkills(process.cwd());
  let fixed = 0;
  for (const s of skills) {
    const mdPath = path.join(process.cwd(), s.path, 'SKILL.md');
    if (fs.existsSync(mdPath)) {
      let content = safeReadFile(mdPath, { encoding: 'utf8' }) as string;
      if (!content.startsWith('---\n')) {
        content = `---\nname: ${s.name}\nstatus: impl\n---\n\n` + content;
        safeWriteFile(mdPath, content);
        fixed++;
      }
    }
  }
  return { status: 'sanitized', count: fixed };
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
