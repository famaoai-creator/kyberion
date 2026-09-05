/** PI-08: keep the public lifecycle graph and runtime hook vocabulary aligned. */
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { LIFECYCLE_HOOK_EVENTS } from '@agent/core/lifecycle-hook-engine';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const extensionPointsPath = pathResolver.rootResolve('docs/developer/EXTENSION_POINTS.md');
const requiredRuntimeLabels = [
  'pre_tool_use',
  'post_tool_use',
  'post_tool_use_failure',
  'user_prompt_submit',
  'stop',
  'stop_failure',
  'session_start',
  'before_agent_start',
  'session_end',
  'subagent_start',
  'subagent_stop',
  'pre_compact',
  'post_compact',
  'notification',
  'task_settled',
];

export function checkExtensionOrder(): { runtimeEvents: number } {
  const document = readTextFile(extensionPointsPath);
  const contractStart = document.indexOf('## 2.11 Lifecycle order');
  const contractEnd = document.indexOf('\n## 3. Semver Rules', contractStart);
  if (contractStart < 0 || contractEnd < 0) {
    throw new Error('[check:extension-order] lifecycle order section is missing');
  }

  const contract = document.slice(contractStart, contractEnd);
  const normalizedContract = contract.replace(/\s+/gu, ' ');
  const missingFromDocument = LIFECYCLE_HOOK_EVENTS.filter(
    (label) => !contract.includes(`\`${label}\``)
  );
  const unexpectedRuntimeLabels = requiredRuntimeLabels.filter(
    (label) => !LIFECYCLE_HOOK_EVENTS.includes(label as (typeof LIFECYCLE_HOOK_EVENTS)[number])
  );
  if (missingFromDocument.length > 0 || unexpectedRuntimeLabels.length > 0) {
    throw new Error(
      `[check:extension-order] runtime/document mismatch: missing_from_document=${missingFromDocument.join(',') || 'none'} unexpected_runtime_labels=${unexpectedRuntimeLabels.join(',') || 'none'}`
    );
  }

  for (const marker of [
    'serial preflight + repair',
    'parallel siblings',
    'one terminal receipt',
    'at most once per top-level pipeline run',
  ]) {
    if (!normalizedContract.includes(marker)) {
      throw new Error(`[check:extension-order] lifecycle contract is missing marker: ${marker}`);
    }
  }

  return { runtimeEvents: requiredRuntimeLabels.length };
}

export const runCheckExtensionOrder = defineScript({
  name: 'check:extension-order',
  flags: [],
  run(context) {
    let result: { runtimeEvents: number };
    try {
      result = checkExtensionOrder();
    } catch (error) {
      throw new ScriptExitError(1, error instanceof Error ? error.message : String(error));
    }
    context.print(`[check:extension-order] OK (${result.runtimeEvents} runtime events)`);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'check_extension_order.ts') ||
  isDirectScript(import.meta.url, 'check_extension_order.js')
)
  void runCheckExtensionOrder();
