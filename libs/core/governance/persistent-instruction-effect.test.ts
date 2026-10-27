import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describePersistentInstructionWrite,
  describeOpaqueInstructionExecution,
  isPersistentInstructionPath,
} from './persistent-instruction-effect.js';
import { policyEngine } from './policy-engine.js';
import { auditChain } from './audit-chain.js';
import {
  safeMkdir,
  safeRmSync,
  safeWriteFile,
  safeReadFile,
  safeExecShellScriptResult,
  assertGovernedExec,
} from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) safeRmSync(root);
});
const bytes = (text: string) => Buffer.from(text, 'utf8');
describe('persistent instruction effect classification', () => {
  it('recognizes case variants and canonical aliases, while ordinary documents remain ordinary', () => {
    expect(isPersistentInstructionPath('/workspace/aGeNtS.Md')).toBe(true);
    expect(isPersistentInstructionPath('/workspace/notes.txt', '/workspace/AGENTS.md')).toBe(true);
    expect(isPersistentInstructionPath('/workspace/GEMINI.md')).toBe(true);
    expect(isPersistentInstructionPath('/workspace/docs/README.md')).toBe(false);
  });

  it('binds path, canonical target and observed before/after hashes without retaining raw instructions', () => {
    const input = {
      logicalPath: '/workspace/AGENTS.md',
      canonicalPath: '/workspace/AGENTS.md',
      before: bytes('old private text'),
      after: bytes('new private text'),
    };
    const first = describePersistentInstructionWrite(input)!;
    expect(first).toMatchObject({
      binding_kind: 'observed_write_intent',
      before_state: 'known',
      content_changed: true,
    });
    expect(first.diff_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain('private text');
    for (const changed of [
      { ...input, before: bytes('other') },
      { ...input, after: bytes('other') },
      { ...input, canonicalPath: '/other/AGENTS.md' },
    ]) {
      expect(describePersistentInstructionWrite(changed)!.diff_sha256).not.toBe(first.diff_sha256);
    }
  });

  it('does not fabricate an exact diff for unreadable old bytes and recognizes no-op content', () => {
    const base = {
      logicalPath: '/workspace/AGENTS.md',
      canonicalPath: '/workspace/AGENTS.md',
      after: bytes('same'),
    };
    const unknown = describePersistentInstructionWrite({ ...base, before: 'unavailable' })!;
    expect(unknown.before_state).toBe('unavailable');
    expect(unknown.diff_sha256).toBeUndefined();
    expect(unknown.content_changed).toBeUndefined();
    expect(
      describePersistentInstructionWrite({ ...base, before: bytes('same') })!.content_changed
    ).toBe(false);
    expect(describePersistentInstructionWrite({ ...base, before: null })!.before_state).toBe(
      'absent'
    );
  });

  it('marks opaque shell/patch targets unresolved regardless of apparent filenames', () => {
    expect(describeOpaqueInstructionExecution('/bin/sh', ['-c', 'echo AGENTS.md'])).toMatchObject({
      effect_class: 'opaque_shell_execution',
      instruction_targets: 'unresolved',
    });
    expect(
      describeOpaqueInstructionExecution('apply_patch', ['*** Update File: AGENTS.md'])
    ).toMatchObject({ effect_class: 'opaque_patch_execution', instruction_targets: 'unresolved' });
    expect(describeOpaqueInstructionExecution('git', ['status'])).toBeUndefined();
  });

  it('connects real file writes and patch-shaped replacements to the existing policy/audit boundary', () => {
    const root = pathResolver.sharedTmp(`vitest-instruction-effect-${randomUUID()}`);
    roots.push(root);
    safeMkdir(root, { recursive: true });
    const evaluate = vi
      .spyOn(policyEngine, 'evaluate')
      .mockReturnValue({ allowed: true, action: 'allow' });
    const audit = vi.spyOn(auditChain, 'record').mockImplementation(() => undefined as never);
    const target = path.join(root, 'AGENTS.md');
    safeWriteFile(target, 'original private instructions');
    safeWriteFile(target, 'patched private instructions');
    const writes = evaluate.mock.calls
      .map(([ctx]) => ctx)
      .filter((ctx) => ctx.operation === 'file_write' && ctx.effect_class);
    expect(writes).toHaveLength(2);
    expect(writes[1]!.persistent_instruction_effect).toMatchObject({
      before_state: 'known',
      content_changed: true,
      canonical_path: target,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'persistent_instruction_write', result: 'completed' })
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('private instructions');
    expect(safeReadFile(target, { encoding: 'utf8' })).toBe('patched private instructions');
  });

  it('does not turn classification into permission or a completed effect on policy denial', () => {
    const root = pathResolver.sharedTmp(`vitest-instruction-denied-${randomUUID()}`);
    roots.push(root);
    safeMkdir(root, { recursive: true });
    const evaluate = vi
      .spyOn(policyEngine, 'evaluate')
      .mockReturnValue({ allowed: false, action: 'deny', message: 'fixture denied' });
    const audit = vi.spyOn(auditChain, 'record').mockImplementation(() => undefined as never);
    expect(() => safeWriteFile(path.join(root, 'AGENTS.md'), 'attempt')).toThrow('POLICY_BLOCKED');
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'file_write',
        effect_class: 'persistent_agent_instruction_change',
      })
    );
    expect(
      audit.mock.calls.some(([entry]) => entry.action === 'persistent_instruction_write')
    ).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'connects the real shell boundary without granting or inferring a target',
    () => {
      const evaluate = vi
        .spyOn(policyEngine, 'evaluate')
        .mockReturnValue({ allowed: true, action: 'allow' });
      expect(safeExecShellScriptResult('/bin/sh', ':').status).toBe(0);
      expect(evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'execute_command',
          effect_class: 'opaque_shell_execution',
          instruction_targets: 'unresolved',
        })
      );
      assertGovernedExec('patch', ['--version']);
      expect(evaluate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          operation: 'execute_command',
          effect_class: 'opaque_patch_execution',
          instruction_targets: 'unresolved',
        })
      );
    }
  );
});
