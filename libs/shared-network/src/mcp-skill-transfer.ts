/**
 * First-party / transferable Kyberion skills for MCP Resources and skill.* tools.
 * Only repo plugins under plugins/ are exposed (no personal/confidential paths).
 */
import * as path from 'node:path';
import { parseSafeJsonInput, readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';

export type TransferableSkill = {
  plugin_id: string;
  skill_id: string;
  title: string;
  description: string;
  uri: string;
  path: string;
};

const PLUGIN_ROOTS: Array<{ plugin_id: string; relative: string }> = [
  { plugin_id: 'kyberion', relative: 'plugins/kyberion' },
  { plugin_id: 'kyberion-agent-plugin', relative: 'plugins/kyberion-agent-plugin' },
  { plugin_id: 'kyberion-claude-code', relative: 'plugins/kyberion-claude-code' },
];

function parseSkillFrontmatter(content: string): { title?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const title = block
    .match(/^name:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, '');
  const description = block
    .match(/^description:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, '');
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

function skillUri(pluginId: string, skillId: string): string {
  return `kyberion://skill/${encodeURIComponent(pluginId)}/${encodeURIComponent(skillId)}`;
}

function collectSkillFiles(pluginId: string, pluginRoot: string): TransferableSkill[] {
  const out: TransferableSkill[] = [];
  const rootSkill = path.join(pluginRoot, 'SKILL.md');
  if (safeExistsSync(rootSkill) && safeLstat(rootSkill).isFile()) {
    const content = readTextFile(rootSkill);
    const meta = parseSkillFrontmatter(content);
    out.push({
      plugin_id: pluginId,
      skill_id: pluginId,
      title: meta.title || pluginId,
      description: meta.description || '',
      uri: skillUri(pluginId, pluginId),
      path: rootSkill,
    });
  }
  const skillsDir = path.join(pluginRoot, 'skills');
  if (!safeExistsSync(skillsDir) || !safeLstat(skillsDir).isDirectory()) return out;
  for (const entry of safeReaddir(skillsDir)) {
    const skillMd = path.join(skillsDir, entry, 'SKILL.md');
    if (!safeExistsSync(skillMd) || !safeLstat(skillMd).isFile()) continue;
    const content = readTextFile(skillMd);
    const meta = parseSkillFrontmatter(content);
    out.push({
      plugin_id: pluginId,
      skill_id: entry,
      title: meta.title || entry,
      description: meta.description || '',
      uri: skillUri(pluginId, entry),
      path: skillMd,
    });
  }
  return out;
}

export function listTransferableSkills(): TransferableSkill[] {
  const root = pathResolver.rootDir();
  const skills: TransferableSkill[] = [];
  for (const plugin of PLUGIN_ROOTS) {
    const pluginRoot = path.join(root, plugin.relative);
    if (!safeExistsSync(pluginRoot)) continue;
    skills.push(...collectSkillFiles(plugin.plugin_id, pluginRoot));
  }
  return skills.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
}

export function getTransferableSkill(pluginId: string, skillId: string): TransferableSkill | null {
  return (
    listTransferableSkills().find(
      (skill) => skill.plugin_id === pluginId && skill.skill_id === skillId
    ) || null
  );
}

export function readTransferableSkillBody(skill: TransferableSkill): string {
  return readTextFile(skill.path);
}

export function parseSkillResourceUri(uri: string): { plugin_id: string; skill_id: string } | null {
  const match = /^kyberion:\/\/skill\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!match) return null;
  return {
    plugin_id: decodeURIComponent(match[1]),
    skill_id: decodeURIComponent(match[2]),
  };
}

/** Sanity helper for tests — ensures frontmatter parse does not throw on JSON-ish skills. */
export function parsePluginManifestSafe(raw: string): unknown {
  try {
    return parseSafeJsonInput(raw, 'plugin manifest');
  } catch {
    return null;
  }
}
