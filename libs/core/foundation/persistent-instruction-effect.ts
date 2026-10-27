import * as path from 'node:path';
import { createHash } from 'node:crypto';

const INSTRUCTION_NAMES = new Set([
  'agents.md',
  'claude.md',
  'codex.md',
  'gemini.md',
  'soul.md',
  '.cursorrules',
  '.clinerules',
]);
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Classification only. This does not supply an approval, grant, or authority context. */
export function isPersistentInstructionPath(
  logicalPath: string,
  canonicalPath = logicalPath
): boolean {
  return [logicalPath, canonicalPath].some((candidate) =>
    INSTRUCTION_NAMES.has(path.basename(path.resolve(candidate)).toLowerCase())
  );
}

export interface PersistentInstructionWriteEffect {
  effect_class: 'persistent_agent_instruction_change';
  /** Observed intent, not a CAS receipt for the committed filesystem diff. */
  binding_kind: 'observed_write_intent';
  logical_path: string;
  canonical_path: string;
  before_state: 'absent' | 'known' | 'unavailable';
  before_sha256?: string;
  after_sha256: string;
  /** Unknown old bytes cannot yield an exact change receipt. */
  diff_sha256?: string;
  content_changed?: boolean;
}

export function describePersistentInstructionWrite(input: {
  logicalPath: string;
  canonicalPath: string;
  before: Uint8Array | null | 'unavailable';
  after: Uint8Array;
}): PersistentInstructionWriteEffect | undefined {
  if (!isPersistentInstructionPath(input.logicalPath, input.canonicalPath)) return;
  const beforeState: PersistentInstructionWriteEffect['before_state'] =
    input.before === null ? 'absent' : input.before === 'unavailable' ? 'unavailable' : 'known';
  const beforeHash =
    typeof input.before === 'object' && input.before !== null ? digest(input.before) : undefined;
  const afterHash = digest(input.after);
  const binding: Pick<
    PersistentInstructionWriteEffect,
    'logical_path' | 'canonical_path' | 'before_state' | 'before_sha256' | 'after_sha256'
  > = {
    logical_path: path.resolve(input.logicalPath),
    canonical_path: path.resolve(input.canonicalPath),
    before_state: beforeState,
    ...(beforeHash ? { before_sha256: beforeHash } : {}),
    after_sha256: afterHash,
  };
  return {
    effect_class: 'persistent_agent_instruction_change',
    binding_kind: 'observed_write_intent',
    ...binding,
    ...(beforeState !== 'unavailable'
      ? { diff_sha256: digest(JSON.stringify(binding)), content_changed: beforeHash !== afterHash }
      : {}),
  };
}

/** Opaque child execution cannot prove which file or resulting bytes it changes.
 * Keep that uncertainty visible rather than deriving permission from shell text. */
export function describeOpaqueInstructionExecution(command: string, args: readonly string[]) {
  const executable = path
    .basename(command)
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (['patch', 'apply_patch'].includes(executable))
    return {
      effect_class: 'opaque_patch_execution',
      instruction_targets: 'unresolved',
      command_sha256: digest(JSON.stringify([command, ...args])),
    };
  if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'cmd', 'powershell', 'pwsh'].includes(executable))
    return {
      effect_class: 'opaque_shell_execution',
      instruction_targets: 'unresolved',
      command_sha256: digest(JSON.stringify([command, ...args])),
    };
  return undefined;
}
