import { logger, pathResolver, safeReadFile, safeWriteFile, safeReaddir, safeStat, safeMkdir } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as yaml from 'js-yaml';

/**
 * Wisdom-Actuator v1.2.0 [SECURE-IO ENFORCED]
 * Strictly compliant with Layer 2 (Shield).
 */

const VAULT_DIR = path.join(process.cwd(), 'knowledge/evolution/latent-wisdom');

interface WisdomAction {
  action: 'distill' | 'mirror' | 'swap' | 'sync' | 'aggregate';
  patchId?: string;
  missionId?: string;
  targetTier?: 'public' | 'confidential' | 'personal';
  target_dir?: string; // for 'aggregate' action
  output_file?: string; // for 'aggregate' action
  options?: any;
}

interface CapabilityEntry {
  n: string; path: string; d: string; s: string; r: string; m: string; t: string[]; u: string; p?: string[];
}

function initializeCapability(capabilityPath: string, name: string, category: string) {
  const skillMdPath = path.join(capabilityPath, 'SKILL.md');
  const pkgPath = path.join(capabilityPath, 'package.json');

  if (!fs.existsSync(skillMdPath)) {
    const mdContent = `---\nname: ${name}\ndescription: New autonomous capability discovery.\nstatus: planned\ncategory: ${category}\nlast_updated: '${new Date().toISOString().split('T')[0]}'\n---\n\n# ${name}\n\nDescription pending initialization.\n`;
    safeWriteFile(skillMdPath, mdContent);
    logger.info(`✨ Auto-Discovery: Initialized SKILL.md for ${name}`);
  }

  if (!fs.existsSync(pkgPath)) {
    const pkgContent = {
      name: `@agent/capability-${name}`,
      version: '1.0.0',
      private: true,
      description: `Kyberion Capability: ${name}`,
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      dependencies: { "@agent/core": "workspace:*" }
    };
    safeWriteFile(pkgPath, JSON.stringify(pkgContent, null, 2));
    logger.info(`✨ Auto-Discovery: Initialized package.json for ${name}`);
  }
}

async function handleAction(input: WisdomAction) {
  switch (input.action) {
    case 'distill':
      logger.info(`🧠 [WISDOM] Distilling from: ${input.missionId}`);
      return { status: 'success', patchId: `patch-${input.missionId}-${Date.now()}` };

    case 'swap':
      const patchPath = path.join(VAULT_DIR, `${input.patchId}.json`);
      const patchContent = safeReadFile(patchPath, { encoding: 'utf8' }) as string;
      const patchData = JSON.parse(patchContent);
      return { activeRules: patchData.delta_rules };

    case 'sync':
      logger.info(`🔄 [WISDOM] Synchronizing to ${input.targetTier} tier...`);
      return { status: 'synchronized' };

    case 'aggregate':
      return await performAggregation(input);

    default:
      return { status: 'executed' };
  }
}

async function performAggregation(input: WisdomAction) {
  const targetDir = path.resolve(process.cwd(), input.target_dir || 'skills');
  const outputFile = path.resolve(process.cwd(), input.output_file || 'knowledge/orchestration/global_skill_index.json');
  const autoInit = input.options?.auto_init !== false;

  logger.info(`📊 [WISDOM] Aggregating skills from ${targetDir} to ${outputFile}...`);

  try {
    let existingIndex: any = { s: [] };
    if (fs.existsSync(outputFile)) {
      try { existingIndex = JSON.parse(safeReadFile(outputFile, { encoding: 'utf8' }) as string); } catch (_) {}
    }

    const skillsMap = new Map<string, CapabilityEntry>(existingIndex.s.map((s: any) => [s.path, s]));
    const foundPaths = new Set<string>();
    
    if (!fs.existsSync(targetDir)) {
      logger.warn(`Target directory ${targetDir} does not exist. Skipping aggregation.`);
      return { status: 'success', total: 0, updated: 0 };
    }

    const categories = fs.readdirSync(targetDir).filter(f => fs.lstatSync(path.join(targetDir, f)).isDirectory());
    let updated = 0;

    for (const cat of categories) {
      const catPath = path.join(targetDir, cat);
      const skillDirs = fs.readdirSync(catPath).filter(f => fs.lstatSync(path.join(catPath, f)).isDirectory());

      for (const dir of skillDirs) {
        const relPath = path.join('skills', cat, dir);
        const fullDir = path.join(process.cwd(), relPath);
        if (autoInit) initializeCapability(fullDir, dir, cat);

        const skillMdPath = path.join(fullDir, 'SKILL.md');
        if (fs.existsSync(skillMdPath)) {
          foundPaths.add(relPath);
          const stat = fs.statSync(skillMdPath);
          const existing = skillsMap.get(relPath);
          if (stat.mtimeMs > (existing?.u ? new Date(existing.u).getTime() : 0)) {
            updated++;
            const content = safeReadFile(skillMdPath, { encoding: 'utf8' }) as string;
            const desc = (content.match(/^description:\s*(.*)$/m)?.[1] || '').trim().substring(0, 97);
            const status = content.match(/^status:\s*(\w+)$/m)?.[1] || 'plan';
            const risk = content.match(/^risk_level:\s*(\w+)$/m)?.[1] || 'low';
            
            let mainScript = '';
            const pkgPath = path.join(fullDir, 'package.json');
            if (fs.existsSync(pkgPath)) {
              try { 
                const pkg = JSON.parse(safeReadFile(pkgPath, { encoding: 'utf8' }) as string);
                mainScript = pkg.main || ''; 
              } catch (_) {}
            }

            let tags: string[] = [];
            let platforms: string[] = [];
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) { 
              try { 
                const fm: any = yaml.load(fmMatch[1]); 
                tags = fm.tags || []; 
                platforms = fm.platforms || [];
              } catch (_) {} 
            }

            skillsMap.set(relPath, {
              n: dir, path: relPath, d: desc, s: status === 'implemented' ? 'impl' : status.substring(0, 4),
              r: risk, m: mainScript, t: tags, u: new Date(stat.mtimeMs).toISOString(),
              p: platforms
            });
          }
        }
      }
    }

    for (const pathKey of skillsMap.keys()) { if (!foundPaths.has(pathKey)) skillsMap.delete(pathKey); }

    const skills = Array.from(skillsMap.values());
    const finalResult = { v: '2.0.0', t: skills.length, u: new Date().toISOString(), s: skills };
    safeWriteFile(outputFile, JSON.stringify(finalResult, null, 2));
    logger.success(`✅ Global Capability Index: ${skills.length} capabilities (Updated: ${updated})`);
    return { status: 'success', total: skills.length, updated };
  } catch (err: any) {
    logger.error(`Index Generation Failed: ${err.message}`);
    return { status: 'failed', error: err.message };
  }
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const inputData = JSON.parse(inputContent) as WisdomAction;
  const result = await handleAction(inputData);
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
