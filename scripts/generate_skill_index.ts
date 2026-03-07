/**
 * scripts/generate_skill_index.ts
 * Advanced Capability Discovery & Indexer.
 * [SECURE-IO COMPLIANT VERSION]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { logger, safeReadFile, safeWriteFile, pathResolver } from '@agent/core';

const indexFile = pathResolver.knowledge('orchestration/global_skill_index.json');

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

async function main() {
  try {
    let existingIndex: any = { s: [] };
    if (fs.existsSync(indexFile)) {
      try { existingIndex = JSON.parse(safeReadFile(indexFile, { encoding: 'utf8' }) as string); } catch (_) {}
    }

    const skillsMap = new Map<string, CapabilityEntry>(existingIndex.s.map((s: any) => [s.path, s]));
    const foundPaths = new Set<string>();
    const skillsRootDir = path.join(process.cwd(), 'skills');
    
    if (!fs.existsSync(skillsRootDir)) return;

    const categories = fs.readdirSync(skillsRootDir).filter(f => fs.lstatSync(path.join(skillsRootDir, f)).isDirectory());
    let updated = 0;

    for (const cat of categories) {
      const catPath = path.join(skillsRootDir, cat);
      const skillDirs = fs.readdirSync(catPath).filter(f => fs.lstatSync(path.join(catPath, f)).isDirectory());

      for (const dir of skillDirs) {
        const relPath = path.join('skills', cat, dir);
        const fullDir = path.join(process.cwd(), relPath);
        initializeCapability(fullDir, dir, cat);

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
    safeWriteFile(indexFile, JSON.stringify({ v: '2.0.0', t: skills.length, u: new Date().toISOString(), s: skills }, null, 2));
    logger.success(`✅ Global Capability Index: ${skills.length} capabilities (Updated: ${updated})`);
  } catch (err: any) {
    logger.error(`Index Generation Failed: ${err.message}`);
  }
}

main();
