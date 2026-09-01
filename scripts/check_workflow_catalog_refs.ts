#!/usr/bin/env node
/**
 * Workflow Catalog Reference Check
 *
 * Static integrity gate for the mission workflow catalog's process templates
 * (MO-01). Fails when:
 *  - a phase spec's `pipeline_ref` / `brief_ref` points at a file that does
 *    not exist in the repository;
 *  - a template's `default_tasks` cannot be expanded into a valid
 *    NEXT_TASKS.json plan (duplicate ids, unresolved review_target_suffix,
 *    dependency cycles, reviewer-invariant violations).
 *
 * The expansion itself is exercised with a dummy mission id so a broken
 * catalog entry fails here, at validate time, instead of bricking dispatch.
 */

import * as path from 'node:path';
import { expandProcessTemplateTasks } from '@agent/core/mission-process-task-expansion';
import {
  loadMissionWorkflowCatalog,
  normalizeWorkflowPhases,
} from '@agent/core/mission-workflow-catalog';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export function checkWorkflowCatalogRefs(): string[] {
  const catalog = loadMissionWorkflowCatalog();
  const violations: string[] = [];

  for (const template of catalog.templates) {
    const { specs, hasSpecEntries } = normalizeWorkflowPhases(template.phases as never);
    if (!hasSpecEntries) continue;

    for (const spec of specs) {
      for (const refKey of ['pipeline_ref', 'brief_ref'] as const) {
        const ref = spec[refKey];
        if (typeof ref !== 'string' || !ref.trim()) continue;
        const resolved = path.isAbsolute(ref) ? ref : path.join(pathResolver.rootDir(), ref);
        if (!safeExistsSync(resolved)) {
          violations.push(`${template.id}: phase ${spec.id} ${refKey} not found: ${ref}`);
        }
      }
      // Every task-bearing phase needs an exit gate — otherwise gate-pass
      // can never mark its tasks completed (SR-01 finding #2).
      if ((spec.default_tasks?.length ?? 0) > 0 && !spec.exit_gate) {
        violations.push(`${template.id}: phase ${spec.id} has default_tasks but no exit_gate`);
      }
      for (const task of spec.default_tasks ?? []) {
        if (typeof task.pipeline_ref === 'string' && task.pipeline_ref.trim()) {
          const resolved = path.isAbsolute(task.pipeline_ref)
            ? task.pipeline_ref
            : path.join(pathResolver.rootDir(), task.pipeline_ref);
          if (!safeExistsSync(resolved)) {
            violations.push(
              `${template.id}: task ${spec.id}-${task.task_id_suffix} pipeline_ref not found: ${task.pipeline_ref}`
            );
          }
        }
      }
    }

    try {
      expandProcessTemplateTasks({
        missionId: 'MSN-CATALOG-CHECK',
        design: { workflow_id: template.id, phase_specs: specs },
      });
    } catch (error: any) {
      violations.push(`${template.id}: expansion failed — ${error?.message ?? String(error)}`);
    }
  }

  return violations;
}

export const runCheckWorkflowCatalogRefs = defineScript({
  name: 'check:workflow-catalog-refs',
  flags: [],
  run(context) {
    const violations = checkWorkflowCatalogRefs();
    if (violations.length > 0) {
      throw new ScriptExitError(
        1,
        [
          '❌ Workflow catalog reference check failed:',
          ...violations.map((violation) => `  - ${violation}`),
        ].join('\n')
      );
    }
    context.print('✅ Workflow catalog references and process-template expansions are valid.');
    return { violations };
  },
});

if (
  isDirectScript(import.meta.url, 'check_workflow_catalog_refs.ts') ||
  isDirectScript(import.meta.url, 'check_workflow_catalog_refs.js')
)
  void runCheckWorkflowCatalogRefs();
