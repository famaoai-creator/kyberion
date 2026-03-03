/**
 * scripts/generate_skill_index.ts
 * Scans all directories for SKILL.md and creates a compact JSON index.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { logger, safeReadFile, safeWriteFile } from '@agent/core';
import * as pathResolver from '@agent/core/path-resolver';

const indexFile = pathResolver.knowledge('orchestration/global_skill_index.json');

interface SkillEntry {
  n: string;
  path: string;
  d: string;
  s: string;
  r: string;
  m: string;
  t: string[];
  u: string;
}

async function main() {
  try {
    let existingIndex: any = { s: [] };
    if (fs.existsSync(indexFile)) {
      try {
        existingIndex = JSON.parse(safeReadFile(indexFile, { encoding: 'utf8' }) as string);
      } catch (_) {}
    }

    const skillsMap = new Map<string, SkillEntry>(existingIndex.s.map((s: any) => [s.path, s]));
    const foundPaths = new Set<string>();
    const skillsRootDir = path.join(process.cwd(), 'skills');
    
    if (!fs.existsSync(skillsRootDir)) return;

    const categories = fs.readdirSync(skillsRootDir).filter(f => fs.lstatSync(path.join(skillsRootDir, f)).isDirectory());
    
    let updated = 0;

    for (const cat of categories) {
      const catPath = path.join(skillsRootDir, cat);
      const skillDirs = fs.readdirSync(catPath).filter(f => fs.lstatSync(path.join(catPath, f)).isDirectory());

      for (const dir of skillDirs) {
        const skillPhysicalPath = path.join('skills', cat, dir);
        const skillFullDir = path.join(process.cwd(), skillPhysicalPath);
        const skillMdPath = path.join(skillFullDir, 'SKILL.md');

        if (fs.existsSync(skillMdPath)) {
          foundPaths.add(skillPhysicalPath);
          const stat = fs.statSync(skillMdPath);
          const existing = skillsMap.get(skillPhysicalPath);
          const lastMtime = existing?.u ? new Date(existing.u).getTime() : 0;

          if (stat.mtimeMs > lastMtime) {
            updated++;
            const content = safeReadFile(skillMdPath, { encoding: 'utf8' }) as string;
            
            let desc = (content.match(/^description:\s*(.*)$/m)?.[1] || '').trim();
            if (desc.length > 100) desc = desc.substring(0, 97) + '...';

            const status = content.match(/^status:\s*(\w+)$/m)?.[1] || 'plan';
            const risk = content.match(/^risk_level:\s*(\w+)$/m)?.[1] || 'low';

            let mainScript = '';
            const pkgPath = path.join(skillFullDir, 'package.json');
            if (fs.existsSync(pkgPath)) {
              try {
                mainScript = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).main || '';
              } catch (_) {}
            }

            let tags: string[] = [];
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
              try {
                const fm: any = yaml.load(fmMatch[1]);
                tags = fm.tags || [];
              } catch (_) {}
            }

            skillsMap.set(skillPhysicalPath, {
              n: dir,
              path: skillPhysicalPath,
              d: desc,
              s: status === 'implemented' ? 'impl' : status.substring(0, 4),
              r: risk,
              m: mainScript,
              t: tags,
              u: new Date(stat.mtimeMs).toISOString()
            });
          }
        }
      }
    }

    // Delete stale entries
    for (const pathKey of skillsMap.keys()) {
      if (!foundPaths.has(pathKey)) skillsMap.delete(pathKey);
    }

    const skills = Array.from(skillsMap.values());
    const output = {
      v: '1.3.0',
      t: skills.length,
      u: new Date().toISOString(),
      s: skills,
    };

    safeWriteFile(indexFile, JSON.stringify(output, null, 2));
    console.log(`Global Skill Index updated: ${updated} modified, ${skills.length} total.`);
  } catch (err: any) {
    console.error(`Index Generation Failed: ${err.message}`);
  }
}

main();
