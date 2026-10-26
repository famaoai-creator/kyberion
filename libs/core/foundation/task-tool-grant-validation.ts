/** Dependency-leaf validators shared by task planning and runtime tool admission. */
import * as path from 'node:path';
import { runtimeStatePath } from './runtime-state-roots.js';

export const TASK_SOURCE_ROOTS = [
  'libs/',
  'scripts/',
  'tests/',
  'docs/',
  'pipelines/',
  'knowledge/product/',
];

export function validateTaskSourcePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new Error('[TASK_SOURCE_GRANT_INVALID] source_edit_paths must be an array of strings');
  if (value.length > 64) throw new Error('[TASK_SOURCE_GRANT_INVALID] Too many source files');
  return [...new Set(value as string[])]
    .map((entry) => {
      if (
        path.isAbsolute(entry) ||
        entry.includes('\\') ||
        entry
          .split('/')
          .some(
            (part, index) =>
              !part ||
              part === '.' ||
              part === '..' ||
              (part.startsWith('.') && !(index === 0 && part === '.worktrees'))
          ) ||
        (!TASK_SOURCE_ROOTS.some((root) => entry.startsWith(root)) &&
          ![
            'active/shared/tmp/',
            runtimeStatePath('task.workspacesRoot').physicalPath + '/',
            '.worktrees/',
          ].some((root) => entry.startsWith(root)))
      )
        throw new Error(
          `[TASK_SOURCE_GRANT_INVALID] Source path is outside public code roots: ${entry}`
        );
      return entry;
    })
    .sort();
}

export function validateTaskPipelineRefs(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some(
      (ref) =>
        typeof ref !== 'string' ||
        !ref.startsWith('pipelines/') ||
        !ref.endsWith('.json') ||
        ref.includes('\\') ||
        ref.split('/').some((part) => !part || part.startsWith('.'))
    )
  )
    throw new Error(
      '[TASK_PIPELINE_GRANT_INVALID] allowed_pipelines must name exact repository pipelines/*.json files'
    );
  return [...new Set(value as string[])].sort();
}
