/**
 * scripts/refactor/mission-project-ledger.ts
 * Project ledger synchronization utilities for missions.
 */

import * as path from 'node:path';
import {
  findMissionPath,
  logger,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';
import { loadState, readJsonFileSafe } from './mission-state.js';
import { readTextFile } from './cli-input.js';

export function resolveProjectLedgerPath(projectPath: string): string {
  const resolved = pathResolver.rootResolve(projectPath);
  if (resolved.endsWith('.md')) return resolved;
  return path.join(resolved, '04_control', 'mission-ledger.md');
}

export function resolveProjectLedgerJsonPath(projectPath: string): string {
  const resolved = pathResolver.rootResolve(projectPath);
  if (resolved.endsWith('.json')) return resolved;
  if (resolved.endsWith('.md')) return resolved.replace(/\.md$/i, '.json');
  return path.join(resolved, '04_control', 'mission-ledger.json');
}

export function ensureProjectMissionLedgerExists(ledgerPath: string): void {
  if (safeExistsSync(ledgerPath)) return;
  const blueprintPath = pathResolver.knowledge('public/templates/blueprints/mission-ledger.md');
  const ledgerDir = path.dirname(ledgerPath);
  if (!safeExistsSync(ledgerDir)) safeMkdir(ledgerDir, { recursive: true });
  const blueprint = safeReadFile(blueprintPath, { encoding: 'utf8' }) as string;
  safeWriteFile(ledgerPath, blueprint);
}

export function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

export function upsertMissionLedgerRow(content: string, row: string, missionId: string): string {
  const lines = content.split('\n');
  const headerIndex = lines.findIndex((line) => line.includes('| Mission ID | Relationship | Status | Summary |'));
  if (headerIndex === -1) {
    return `${content.trimEnd()}\n\n## Mission Ledger\n\n| Mission ID | Relationship | Status | Summary | Affected Artifacts | Gate Impact | Traceability Refs |\n|---|---|---|---|---|---|---|\n${row}\n`;
  }

  let tableEnd = headerIndex + 2;
  while (tableEnd < lines.length && lines[tableEnd].trim().startsWith('|')) {
    tableEnd += 1;
  }

  const tableRows = lines.slice(headerIndex + 2, tableEnd);
  const filteredRows = tableRows.filter((line) => !line.startsWith(`| ${missionId} |`));
  filteredRows.push(row);
  const nextLines = [
    ...lines.slice(0, headerIndex + 2),
    ...filteredRows,
    ...lines.slice(tableEnd),
  ];
  return `${nextLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
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
  const ledgerDir = path.dirname(ledgerJsonPath);
  if (!safeExistsSync(ledgerDir)) safeMkdir(ledgerDir, { recursive: true });

  const summary = escapeTableCell(project.note || `${state.mission_type || 'mission'} / ${state.assigned_persona}`);
  const artifacts = escapeTableCell((project.affected_artifacts || []).join(', '));
  const traceability = escapeTableCell((project.traceability_refs || []).join(', '));
  const row = `| ${upperId} | ${project.relationship_type} | ${state.status} | ${summary} | ${artifacts} | ${project.gate_impact || 'none'} | ${traceability} |`;

  const current = readTextFile(ledgerPath);
  const updated = upsertMissionLedgerRow(current, row, upperId);
  safeWriteFile(ledgerPath, updated);

  const projectId = project.project_id || path.basename(path.dirname(path.dirname(ledgerJsonPath)));
  const jsonLedger = readJsonFileSafe(ledgerJsonPath) || {
    project_id: projectId,
    project_name: projectId,
    entries: [],
  };
  jsonLedger.project_id = jsonLedger.project_id || projectId;
  jsonLedger.project_name = jsonLedger.project_name || projectId;
  const nextEntry = {
    mission_id: upperId,
    relationship_type: project.relationship_type,
    status: state.status,
    summary: project.note || `${state.mission_type || 'mission'} / ${state.assigned_persona}`,
    affected_artifacts: project.affected_artifacts || [],
    gate_impact: project.gate_impact || 'none',
    traceability_refs: project.traceability_refs || [],
    owner: state.assigned_persona,
    last_updated: new Date().toISOString(),
  };
  jsonLedger.entries = Array.isArray(jsonLedger.entries) ? jsonLedger.entries : [];
  jsonLedger.entries = jsonLedger.entries.filter((entry: any) => entry?.mission_id !== upperId);
  jsonLedger.entries.push(nextEntry);
  safeWriteFile(ledgerJsonPath, JSON.stringify(jsonLedger, null, 2));

  logger.success(`🔗 Synced mission ${upperId} into project ledger: ${path.relative(rootDir, ledgerPath)} (+ ${path.relative(rootDir, ledgerJsonPath)})`);
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
