/**
 * scripts/refactor/mission-project-ledger.ts
 * Project ledger synchronization utilities for missions.
 */

import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { logger } from './core.js';
import { resolveMissionLedgerPolicy } from './mission-ledger-policy.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import { loadState } from './mission-state.js';
import {
  loadProjectMissionLedgerAtPath,
  writeProjectMissionLedgerAtPath,
  type ProjectMissionLedger,
} from './project-mission-ledger.js';
import { readTextFile } from './foundation/text.js';
import { nowIso } from './foundation/time.js';
import { normalizeEventScope } from './event-scope.js';

export function resolveProjectLedgerPath(projectPath: string): string {
  const resolved = pathResolver.rootResolve(projectPath);
  const ledgerPath = resolved.endsWith('.md')
    ? resolved
    : path.join(resolved, '04_control', 'mission-ledger.md');
  return assertSafeRepositoryPath(ledgerPath, { allowMissingLeaf: true });
}

export function resolveProjectLedgerJsonPath(projectPath: string): string {
  const resolved = pathResolver.rootResolve(projectPath);
  const ledgerPath = resolved.endsWith('.json')
    ? resolved
    : resolved.endsWith('.md')
      ? resolved.replace(/\.md$/i, '.json')
      : path.join(resolved, '04_control', 'mission-ledger.json');
  return assertSafeRepositoryPath(ledgerPath, { allowMissingLeaf: true });
}

export function ensureProjectMissionLedgerExists(ledgerPath: string): void {
  const safeLedgerPath = assertSafeRepositoryPath(ledgerPath, { allowMissingLeaf: true });
  if (safeExistsSync(safeLedgerPath)) return;
  const blueprintPath = assertSafeRepositoryPath(
    pathResolver.knowledge('public/templates/blueprints/mission-ledger.md')
  );
  const ledgerDir = assertSafeRepositoryPath(path.dirname(safeLedgerPath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(ledgerDir)) safeMkdir(ledgerDir, { recursive: true });
  const blueprint = readTextFile(blueprintPath);
  safeWriteFile(safeLedgerPath, blueprint);
}

export function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

function readProjectMissionLedger(filePath: string): ProjectMissionLedger | null {
  try {
    return loadProjectMissionLedgerAtPath(filePath);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[PROJECT_MISSION_LEDGER]')) {
      throw error;
    }
    return null;
  }
}

export function upsertMissionLedgerRow(content: string, row: string, missionId: string): string {
  const policy = resolveMissionLedgerPolicy();
  const lines = content.split('\n');
  const headerLine = `| ${policy.table_headers.mission_id} | ${policy.table_headers.relationship} | ${policy.table_headers.status} | ${policy.table_headers.summary} | ${policy.table_headers.affected_artifacts} | ${policy.table_headers.gate_impact} | ${policy.table_headers.traceability_refs} |`;
  const headerIndex = lines.findIndex((line) => line.includes(headerLine));
  if (headerIndex === -1) {
    return `${content.trimEnd()}\n\n## ${policy.section_title}\n\n${headerLine}\n|---|---|---|---|---|---|---|\n${row}\n`;
  }

  let tableEnd = headerIndex + 2;
  while (tableEnd < lines.length && lines[tableEnd].trim().startsWith('|')) {
    tableEnd += 1;
  }

  const tableRows = lines.slice(headerIndex + 2, tableEnd);
  const filteredRows = tableRows.filter((line) => !line.startsWith(`| ${missionId} |`));
  filteredRows.push(row);
  const nextLines = [...lines.slice(0, headerIndex + 2), ...filteredRows, ...lines.slice(tableEnd)];
  return `${nextLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

export function removeMissionFromProjectLedger(projectPath: string, missionId: string): void {
  const upperId = missionId.toUpperCase();
  const ledgerPath = resolveProjectLedgerPath(projectPath);
  const ledgerJsonPath = resolveProjectLedgerJsonPath(projectPath);
  if (safeExistsSync(ledgerPath)) {
    const current = readTextFile(ledgerPath);
    const updated = current
      .split('\n')
      .filter((line) => !line.startsWith(`| ${upperId} |`))
      .join('\n');
    safeWriteFile(ledgerPath, `${updated.trimEnd()}\n`);
  }
  if (safeExistsSync(ledgerJsonPath)) {
    const jsonLedger = readProjectMissionLedger(ledgerJsonPath);
    if (jsonLedger && Array.isArray(jsonLedger.entries)) {
      jsonLedger.entries = jsonLedger.entries.filter((entry: any) => entry?.mission_id !== upperId);
      writeProjectMissionLedgerAtPath(ledgerJsonPath, jsonLedger);
    }
  }
}

export async function syncProjectLedger(id: string, rootDir: string): Promise<void> {
  if (!id) {
    logger.error('Usage: mission_controller sync-project-ledger <MISSION_ID>');
    return;
  }

  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found.`);
    return;
  }

  const project = state.relationships?.project;
  if (!project?.project_path) {
    logger.error(`Mission ${upperId} has no relationships.project.project_path.`);
    return;
  }

  const ledgerPath = resolveProjectLedgerPath(project.project_path);
  const ledgerJsonPath = resolveProjectLedgerJsonPath(project.project_path);
  ensureProjectMissionLedgerExists(ledgerPath);
  const ledgerDir = assertSafeRepositoryPath(path.dirname(ledgerJsonPath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(ledgerDir)) safeMkdir(ledgerDir, { recursive: true });

  const summary = escapeTableCell(
    project.note || `${state.mission_type || 'mission'} / ${state.assigned_persona}`
  );
  const artifacts = escapeTableCell((project.affected_artifacts || []).join(', '));
  const traceability = escapeTableCell((project.traceability_refs || []).join(', '));
  const row = `| ${upperId} | ${project.relationship_type} | ${state.status} | ${summary} | ${artifacts} | ${project.gate_impact || 'none'} | ${traceability} |`;

  const current = readTextFile(ledgerPath);
  const updated = upsertMissionLedgerRow(current, row, upperId);
  safeWriteFile(ledgerPath, updated);

  const projectId = project.project_id || path.basename(path.dirname(path.dirname(ledgerJsonPath)));
  const jsonLedger =
    readProjectMissionLedger(ledgerJsonPath) ||
    ({
      project_id: projectId,
      project_name: projectId,
      entries: [],
    } satisfies ProjectMissionLedger);
  jsonLedger.project_id = jsonLedger.project_id || projectId;
  jsonLedger.project_name = jsonLedger.project_name || projectId;
  const projectScope = resolveProjectLedgerScope(state, projectId);
  const nextEntry = {
    mission_id: upperId,
    relationship_type: project.relationship_type,
    status: state.status,
    summary: project.note || `${state.mission_type || 'mission'} / ${state.assigned_persona}`,
    affected_artifacts: project.affected_artifacts || [],
    gate_impact: project.gate_impact || 'none',
    traceability_refs: project.traceability_refs || [],
    owner: state.assigned_persona,
    last_updated: nowIso(),
    ...(projectScope ? { scope: projectScope } : {}),
  };
  jsonLedger.entries = Array.isArray(jsonLedger.entries) ? jsonLedger.entries : [];
  jsonLedger.entries = jsonLedger.entries.filter((entry: any) => entry?.mission_id !== upperId);
  jsonLedger.entries.push(nextEntry);
  writeProjectMissionLedgerAtPath(ledgerJsonPath, jsonLedger);

  logger.success(
    `🔗 Synced mission ${upperId} into project ledger: ${path.relative(rootDir, ledgerPath)} (+ ${path.relative(rootDir, ledgerJsonPath)})`
  );
}

function resolveProjectLedgerScope(
  state: Record<string, any>,
  projectId: string
): ReturnType<typeof normalizeEventScope> | undefined {
  try {
    return normalizeEventScope({
      scope_kind: 'project',
      tier: (state.tier_scope || state.tier || 'public') as 'personal' | 'confidential' | 'public',
      tenant_slug: state.tenant_slug,
      organization_id: state.organization_id,
      project_id: projectId,
    });
  } catch {
    // Legacy shared/public project records remain valid but are deliberately
    // untenantable until their owning tenant is declared.
    return undefined;
  }
}

export async function syncProjectLedgerIfLinked(id: string, rootDir: string): Promise<void> {
  const state = loadState(id.toUpperCase());
  if (!state?.relationships?.project?.project_path) {
    return;
  }

  try {
    await syncProjectLedger(id, rootDir);
  } catch (err: any) {
    logger.warn(`⚠️ Project ledger sync skipped for ${id}: ${err.message}`);
  }
}
