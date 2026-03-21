import * as path from 'node:path';
import { rawExistsSync, rawMkdirp, rawReadTextFile } from './fs-primitives.js';

/**
 * Path Resolver Utility v4.0 (Protected VFS Edition)
 * Robust directory mapping with metadata for Deep Sandboxing.
 */

function findProjectRoot(startDir: string): string {
  let current = startDir;
  while (current !== path.parse(current).root) {
    if (
      rawExistsSync(path.join(current, 'package.json')) &&
      (rawExistsSync(path.join(current, 'libs/actuators')) || rawExistsSync(path.join(current, 'knowledge')))
    ) {
      return current;
    }
    current = path.dirname(current);
  }
  return process.cwd();
}

const PROJECT_ROOT_DIR = findProjectRoot(process.cwd());
const ACTIVE_ROOT = path.join(PROJECT_ROOT_DIR, 'active');
const ACTIVE_SHARED_ROOT = path.join(ACTIVE_ROOT, 'shared');
const KNOWLEDGE_ROOT = path.join(PROJECT_ROOT_DIR, 'knowledge');
const SCRIPTS_ROOT = path.join(PROJECT_ROOT_DIR, 'scripts');
const VAULT_ROOT = path.join(PROJECT_ROOT_DIR, 'vault');
const VISION_ROOT = path.join(PROJECT_ROOT_DIR, 'vision');
const INDEX_PATHS = [
  path.join(KNOWLEDGE_ROOT, 'public/orchestration/global_actuator_index.json'),
];

export function rootDir() { return PROJECT_ROOT_DIR; }
export function knowledge(subPath = '') { return path.join(KNOWLEDGE_ROOT, subPath); }
export function active(subPath = '') { return path.join(ACTIVE_ROOT, subPath); }
export function scripts(subPath = '') { return path.join(SCRIPTS_ROOT, subPath); }
export function vault(subPath = '') { return path.join(VAULT_ROOT, subPath); }
export function vision(subPath = '') { return path.join(VISION_ROOT, subPath); }
export function capabilityAssets(subPath = '') { return path.join(KNOWLEDGE_ROOT, 'public/capability-assets', subPath); }
export function shared(subPath = '') { return path.join(ACTIVE_SHARED_ROOT, subPath); }
export function sharedTmp(subPath = '') {
  const base = path.join(ACTIVE_SHARED_ROOT, 'tmp');
  if (!rawExistsSync(base)) rawMkdirp(base);
  return path.join(base, subPath);
}
export function sharedExports(subPath = '') {
  const base = path.join(ACTIVE_SHARED_ROOT, 'exports');
  if (!rawExistsSync(base)) rawMkdirp(base);
  return path.join(base, subPath);
}

export function isProtected(filePath: string) {
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(KNOWLEDGE_ROOT)) return true;
  if (resolved.startsWith(VAULT_ROOT)) return true;
  if (resolved.startsWith(VISION_ROOT)) return true;
  if (resolved.startsWith(SCRIPTS_ROOT) && !resolved.includes('active')) return true;
  return false;
}

export function capabilityDir(capabilityName: string) {
  const indexPath = INDEX_PATHS.find(candidate => rawExistsSync(candidate));
  if (!indexPath) return path.join(PROJECT_ROOT_DIR, 'libs/actuators', capabilityName);
  const index = JSON.parse(rawReadTextFile(indexPath));
  const capabilityList = index.actuators || index.s || index.skills || [];
  const capability = capabilityList.find((s: any) => (s.n || s.name) === capabilityName);
  
  if (capability && capability.path) return path.join(PROJECT_ROOT_DIR, capability.path);
  
  // Actuator fallback
  const actuatorPath = path.join(PROJECT_ROOT_DIR, 'libs/actuators', capabilityName);
  if (rawExistsSync(actuatorPath)) return actuatorPath;
  
  return path.join(PROJECT_ROOT_DIR, capabilityName);
}

export const skillDir = capabilityDir;

export function capabilityEntry(capabilityName: string) {
  return path.join(PROJECT_ROOT_DIR, 'dist', 'libs', 'actuators', capabilityName, 'src', 'index.js');
}

export function missionDir(missionId: string, tier: 'personal' | 'confidential' | 'public' = 'confidential') {
  const configPath = path.join(KNOWLEDGE_ROOT, 'public/governance/mission-management-config.json');
  let subPath = 'active/missions';
  
  if (rawExistsSync(configPath)) {
    try {
      const config = JSON.parse(rawReadTextFile(configPath));
      subPath = config.directories?.[tier] || subPath;
    } catch (_) { /* Fallback to default */ }
  }

  const dir = path.join(PROJECT_ROOT_DIR, subPath, missionId);
  if (!rawExistsSync(dir)) rawMkdirp(dir);
  return dir;
}

/**
 * Returns the path to the evidence directory for a given mission.
 */
export function missionEvidenceDir(missionId: string) {
  const missionPath = findMissionPath(missionId);
  if (!missionPath) return null;
  const dir = path.join(missionPath, 'evidence');
  if (!rawExistsSync(dir)) rawMkdirp(dir);
  return dir;
}

/**
 * Searches for a mission directory across all available tiers.
 * Priority: personal -> confidential -> public
 */
export function findMissionPath(missionId: string): string | null {
  const configPath = path.join(KNOWLEDGE_ROOT, 'public/governance/mission-management-config.json');
  const tiers: ('personal' | 'confidential' | 'public')[] = ['personal', 'confidential', 'public'];
  
  if (rawExistsSync(configPath)) {
    try {
      const config = JSON.parse(rawReadTextFile(configPath));
      for (const tier of tiers) {
        const subPath = config.directories?.[tier];
        if (subPath) {
          const fullPath = path.join(PROJECT_ROOT_DIR, subPath, missionId);
          if (rawExistsSync(fullPath)) return fullPath;
        }
      }
    } catch (_) { /* Fallback to legacy search */ }
  }

  // Legacy fallback
  const legacyPath = path.join(ACTIVE_ROOT, 'missions', missionId);
  if (rawExistsSync(legacyPath)) return legacyPath;

  return null;
}

export function resolve(logicalPath: string) {
  if (!logicalPath) return PROJECT_ROOT_DIR;
  if (logicalPath.startsWith('capability://')) {
    const parts = logicalPath.slice(13).split('/');
    return path.join(capabilityDir(parts[0]), parts.slice(1).join('/'));
  }
  if (logicalPath.startsWith('skill://')) {
    const parts = logicalPath.slice(8).split('/');
    return path.join(capabilityDir(parts[0]), parts.slice(1).join('/'));
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
  capabilityAssets,
  shared,
  sharedTmp,
  sharedExports,
  isProtected,
  capabilityEntry,
  capabilityDir,
  skillDir,
  missionDir,
  missionEvidenceDir,
  findMissionPath,
  resolve,
  rootResolve,
};
