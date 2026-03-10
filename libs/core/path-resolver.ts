import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Path Resolver Utility v4.0 (Protected VFS Edition)
 * Robust directory mapping with metadata for Deep Sandboxing.
 */

function findProjectRoot(startDir: string): string {
  let current = startDir;
  while (current !== path.parse(current).root) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      (fs.existsSync(path.join(current, 'libs/actuators')) || fs.existsSync(path.join(current, 'knowledge')))
    ) {
      return current;
    }
    current = path.dirname(current);
  }
  return process.cwd();
}

const PROJECT_ROOT_DIR = findProjectRoot(process.cwd());
const ACTIVE_ROOT = path.join(PROJECT_ROOT_DIR, 'active');
const KNOWLEDGE_ROOT = path.join(PROJECT_ROOT_DIR, 'knowledge');
const SCRIPTS_ROOT = path.join(PROJECT_ROOT_DIR, 'scripts');
const VAULT_ROOT = path.join(PROJECT_ROOT_DIR, 'vault');
const VISION_ROOT = path.join(PROJECT_ROOT_DIR, 'vision');
const INDEX_PATH = path.join(KNOWLEDGE_ROOT, 'public/orchestration/global_skill_index.json');

export function rootDir() { return PROJECT_ROOT_DIR; }
export function knowledge(subPath = '') { return path.join(KNOWLEDGE_ROOT, subPath); }
export function active(subPath = '') { return path.join(ACTIVE_ROOT, subPath); }
export function scripts(subPath = '') { return path.join(SCRIPTS_ROOT, subPath); }
export function vault(subPath = '') { return path.join(VAULT_ROOT, subPath); }
export function vision(subPath = '') { return path.join(VISION_ROOT, subPath); }
export function shared(subPath = '') { return path.join(ACTIVE_ROOT, 'shared', subPath); }

export function isProtected(filePath: string) {
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(KNOWLEDGE_ROOT)) return true;
  if (resolved.startsWith(VAULT_ROOT)) return true;
  if (resolved.startsWith(VISION_ROOT)) return true;
  if (resolved.startsWith(SCRIPTS_ROOT) && !resolved.includes('active')) return true;
  return false;
}

export function skillDir(skillName: string) {
  if (!fs.existsSync(INDEX_PATH)) return path.join(PROJECT_ROOT_DIR, 'libs/actuators', skillName);
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const skillList = index.s || index.skills || [];
  const skill = skillList.find((s: any) => (s.n || s.name) === skillName);
  
  if (skill && skill.path) return path.join(PROJECT_ROOT_DIR, skill.path);
  
  // Actuator fallback
  const actuatorPath = path.join(PROJECT_ROOT_DIR, 'libs/actuators', skillName);
  if (fs.existsSync(actuatorPath)) return actuatorPath;
  
  return path.join(PROJECT_ROOT_DIR, skillName);
}

export function missionDir(missionId: string, tier: 'personal' | 'confidential' | 'public' = 'confidential') {
  const configPath = path.join(KNOWLEDGE_ROOT, 'public/governance/mission-management-config.json');
  let subPath = 'active/missions';
  
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      subPath = config.directories?.[tier] || subPath;
    } catch (_) { /* Fallback to default */ }
  }

  const dir = path.join(PROJECT_ROOT_DIR, subPath, missionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Returns the path to the evidence directory for a given mission.
 */
export function missionEvidenceDir(missionId: string) {
  const missionPath = findMissionPath(missionId);
  if (!missionPath) return null;
  const dir = path.join(missionPath, 'evidence');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Searches for a mission directory across all available tiers.
 * Priority: personal -> confidential -> public
 */
export function findMissionPath(missionId: string): string | null {
  const configPath = path.join(KNOWLEDGE_ROOT, 'public/governance/mission-management-config.json');
  const tiers: ('personal' | 'confidential' | 'public')[] = ['personal', 'confidential', 'public'];
  
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      for (const tier of tiers) {
        const subPath = config.directories?.[tier];
        if (subPath) {
          const fullPath = path.join(PROJECT_ROOT_DIR, subPath, missionId);
          if (fs.existsSync(fullPath)) return fullPath;
        }
      }
    } catch (_) { /* Fallback to legacy search */ }
  }

  // Legacy fallback
  const legacyPath = path.join(ACTIVE_ROOT, 'missions', missionId);
  if (fs.existsSync(legacyPath)) return legacyPath;

  return null;
}

export function resolve(logicalPath: string) {
  if (!logicalPath) return PROJECT_ROOT_DIR;
  if (logicalPath.startsWith('skill://')) {
    const parts = logicalPath.slice(8).split('/');
    return path.join(skillDir(parts[0]), parts.slice(1).join('/'));
  }
  if (logicalPath.startsWith('active/shared/')) {
    return shared(logicalPath.replace('active/shared/', ''));
  }
  return path.isAbsolute(logicalPath) ? logicalPath : path.resolve(PROJECT_ROOT_DIR, logicalPath);
}

export function rootResolve(relativePath: string) {
  return path.isAbsolute(relativePath) ? relativePath : path.join(PROJECT_ROOT_DIR, relativePath);
}

// Named export for older scripts that import * as pathResolver
export const pathResolver = {
  rootDir: () => PROJECT_ROOT_DIR,
  activeRoot: () => ACTIVE_ROOT,
  knowledgeRoot: () => KNOWLEDGE_ROOT,
  scriptsRoot: () => SCRIPTS_ROOT,
  vaultRoot: () => VAULT_ROOT,
  visionRoot: () => VISION_ROOT,
  knowledge,
  active,
  scripts,
  vault,
  vision,
  shared,
  isProtected,
  skillDir,
  missionDir,
  missionEvidenceDir,
  findMissionPath,
  resolve,
  rootResolve,
};
