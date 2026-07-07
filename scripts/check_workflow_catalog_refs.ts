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
import { normalizeWorkflowPhases } from '../libs/core/mission-workflow-catalog.js';
import { pathResolver } from '../libs/core/path-resolver.js';
import { safeExistsSync, safeReadFile } from '../libs/core/secure-io.js';
import { expandProcessTemplateTasks } from '../libs/core/mission-process-task-expansion.js';

const CATALOG_PATH = pathResolver.knowledge('product/governance/mission-workflow-catalog.json');

type CatalogTemplate = {
  id: string;
  phases: Array<string | Record<string, unknown>>;
};

function main(): number {
  const catalog = JSON.parse(safeReadFile(CATALOG_PATH, { encoding: 'utf8' }) as string) as {
    templates: CatalogTemplate[];
  };
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

  if (violations.length > 0) {
    console.error('❌ Workflow catalog reference check failed:');
    for (const violation of violations) console.error(`  - ${violation}`);
    return 1;
  }
  console.log('✅ Workflow catalog references and process-template expansions are valid.');
  return 0;
}

process.exit(main());
