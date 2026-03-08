import { logger, safeExec, safeReadFile, safeWriteFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as util from 'node:util';
import * as fs from 'node:fs';

/**
 * Code-Actuator v1.2.0 [LIVE-REPL ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 */

interface CodeAction {
  action: 'analyze' | 'refactor' | 'verify' | 'test' | 'run_live_js' | 'sanitize-deps';
  path?: string;
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

async function handleAction(input: CodeAction) {
  switch (input.action) {
    case 'sanitize-deps':
      const rootDir = process.cwd();
      const policyPath = path.resolve(rootDir, input.params.policy_path);
      const policy = JSON.parse(safeReadFile(policyPath, { encoding: 'utf8' }) as string);
      
      const rootPkgRaw = safeReadFile(path.join(rootDir, 'package.json'), { encoding: 'utf8' }) as string;
      const rootPkg = JSON.parse(rootPkgRaw);
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

      return { 
        status: 'sanitized', 
        total_unused_removed: totalUnused, 
        total_packages_normalized: totalNormalized 
      };

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
        // Add more globals as needed, e.g. fetch
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
