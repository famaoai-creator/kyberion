import * as path from 'node:path';
import { safeExec, safeReadFile, pathResolver, getAllFiles, logger } from '@agent/core';

/**
 * GitHub Skills Manager Core Library.
 * [SECURE-IO COMPLIANT VERSION]
 */

export interface GitStatus {
  branch: string;
  hasChanges: boolean;
  remote: boolean;
}

export interface SkillEntry {
  name: string;
  path: string;
  category: string;
  isInstalled: boolean;
  gitStatus: GitStatus | null;
}

const ROOT_DIR = pathResolver.rootDir();
const INDEX_PATH = path.join(ROOT_DIR, 'knowledge/orchestration/global_skill_index.json');

export function getGitStatus(dir: string): GitStatus | null {
  try {
    // We check worktree status safely
    const isInsideRes = safeExec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    if (isInsideRes.trim() !== 'true') return null;

    const status = safeExec('git', ['status', '--short'], { cwd: dir }).trim();
    const branch = safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).trim();
    const remote = safeExec('git', ['remote', '-v'], { cwd: dir }).trim();

    return {
      branch,
      hasChanges: status.length > 0,
      remote: remote.length > 0,
    };
  } catch {
    return null;
  }
}

export function getAllSkills(): SkillEntry[] {
  const skillsDir = path.join(ROOT_DIR, 'skills');
  const indexContent = safeReadFile(INDEX_PATH, { encoding: 'utf8' }) as string;
  const index = JSON.parse(indexContent);
  const installedSkills = new Set((index.s || index.skills).map((s: any) => s.n || s.name));

  const results: SkillEntry[] = [];

  // We use a safe directory listing approach via shell if safeReaddir is missing
  try {
    const categories = safeExec('ls', [skillsDir]).trim().split('\n').filter(f => f && !f.includes('.'));

    categories.forEach(category => {
      const categoryDir = path.join(skillsDir, category);
      try {
        const skills = safeExec('ls', [categoryDir]).trim().split('\n').filter(f => f && !f.includes('.'));

        skills.forEach(skillName => {
          const skillPath = path.join(categoryDir, skillName);
          results.push({
            name: skillName,
            path: path.relative(ROOT_DIR, skillPath),
            category,
            isInstalled: installedSkills.has(skillName),
            gitStatus: getGitStatus(skillPath)
          });
        });
      } catch (_) {}
    });
  } catch (e: any) {
    logger.error(`Failed to list skills: ${e.message}`);
  }

  return results;
}

export function syncSkill(skillPath: string): string {
  const fullPath = path.join(ROOT_DIR, skillPath);
  try {
    return safeExec('git', ['pull'], { cwd: fullPath });
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

export function installSkill(skillPath: string): string {
  const fullPath = path.join(ROOT_DIR, skillPath);
  try {
    return safeExec('npm', ['install'], { cwd: fullPath });
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

export function pushSkill(skillPath: string, message: string): string {
  const fullPath = path.join(ROOT_DIR, skillPath);
  try {
    safeExec('git', ['add', '.'], { cwd: fullPath });
    safeExec('git', ['commit', '-m', message], { cwd: fullPath });
    return safeExec('git', ['push'], { cwd: fullPath });
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}
