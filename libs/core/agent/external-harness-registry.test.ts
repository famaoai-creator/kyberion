import { describe, expect, it } from 'vitest';
import {
  createExternalHarnessRegistry,
  validateHarnessDescriptor,
  type HarnessDescriptor,
} from './external-harness-registry.js';

const acpHarness = {
  harness_id: 'openhands-acp',
  kind: 'acp',
  adapter_ref: 'acp-adapter',
  endpoint_or_command: 'https://acp.example.test/rpc',
  capabilities: ['code_edit', 'shell'],
  trust_tier: 'confidential',
  status: 'available',
  provider: 'openhands',
};

const cliHarness = {
  harness_id: 'codex-cli',
  kind: 'cli',
  endpoint_or_command: 'codex exec --json',
  capabilities: ['code_edit'],
  trust_tier: 'public',
  status: 'available',
  provider: 'codex',
};

function codes(messages: { code: string }[]): string[] {
  return messages.map((m) => m.code);
}

describe('validateHarnessDescriptor', () => {
  it('accepts a complete descriptor with no messages', () => {
    expect(validateHarnessDescriptor(acpHarness)).toEqual([]);
  });

  it('rejects non-object input in one message', () => {
    const messages = validateHarnessDescriptor('openhands');
    expect(messages).toEqual([
      expect.objectContaining({ severity: 'error', code: 'HARNESS_DESCRIPTOR_NOT_OBJECT' }),
    ]);
  });

  it('collects all field errors instead of throwing on the first', () => {
    const messages = validateHarnessDescriptor({ kind: 'mystery', status: 'up' });
    const found = codes(messages);
    expect(found).toContain('HARNESS_ID_REQUIRED');
    expect(found).toContain('HARNESS_KIND_INVALID');
    expect(found).toContain('HARNESS_TRUST_TIER_INVALID');
    expect(found).toContain('HARNESS_STATUS_INVALID');
    expect(found).toContain('HARNESS_CAPABILITIES_REQUIRED');
  });

  it('requires endpoint_or_command for acp and cli kinds but not process', () => {
    expect(codes(validateHarnessDescriptor({ ...acpHarness, endpoint_or_command: '' }))).toContain(
      'HARNESS_ENDPOINT_REQUIRED'
    );
    expect(codes(validateHarnessDescriptor({ ...cliHarness, endpoint_or_command: '' }))).toContain(
      'HARNESS_ENDPOINT_REQUIRED'
    );
    expect(
      codes(validateHarnessDescriptor({ ...cliHarness, kind: 'process', endpoint_or_command: '' }))
    ).not.toContain('HARNESS_ENDPOINT_REQUIRED');
  });

  it('warns on empty capability entries and retired status', () => {
    const messages = validateHarnessDescriptor({
      ...cliHarness,
      capabilities: ['code_edit', '  '],
      status: 'retired',
    });
    expect(messages).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'HARNESS_CAPABILITY_ENTRY_INVALID' }),
      expect.objectContaining({ severity: 'warning', code: 'HARNESS_STATUS_RETIRED' }),
    ]);
  });
});

describe('createExternalHarnessRegistry', () => {
  it('registers a valid descriptor and lists it', () => {
    const registry = createExternalHarnessRegistry();
    expect(registry.registerHarness(acpHarness)).toEqual([]);
    expect(registry.registerHarness(cliHarness)).toEqual([]);
    expect(registry.listHarnesses().map((h) => h.harness_id)).toEqual([
      'openhands-acp',
      'codex-cli',
    ]);
    expect(registry.getHarness('codex-cli')?.kind).toBe('cli');
  });

  it('rejects invalid and duplicate registrations without storing', () => {
    const registry = createExternalHarnessRegistry();
    expect(registry.registerHarness({ harness_id: 'broken' })).not.toEqual([]);
    expect(registry.registerHarness(acpHarness)).toEqual([]);
    const duplicate = registry.registerHarness(acpHarness);
    expect(codes(duplicate)).toContain('HARNESS_ID_DUPLICATE');
    expect(registry.listHarnesses()).toHaveLength(1);
  });

  it('resolves by capability only across available harnesses', () => {
    const registry = createExternalHarnessRegistry();
    registry.registerHarness(cliHarness);
    registry.registerHarness({ ...acpHarness, status: 'unavailable' });
    registry.registerHarness({
      ...acpHarness,
      harness_id: 'aider-cli',
      kind: 'cli',
      capabilities: ['code_edit', 'shell'],
      status: 'available',
    });

    expect(registry.resolveHarness('shell')?.harness_id).toBe('aider-cli');
    expect(registry.resolveHarness('code_edit')?.harness_id).toBe('codex-cli');
    expect(registry.resolveHarness('browse')).toBeUndefined();
    expect(registry.resolveHarness('  ')).toBeUndefined();
  });

  it('status filter and status transitions affect resolution', () => {
    const registry = createExternalHarnessRegistry();
    registry.registerHarness(acpHarness);
    expect(registry.resolveHarness('shell')?.harness_id).toBe('openhands-acp');

    expect(registry.updateHarnessStatus('openhands-acp', 'unavailable')).toBe(true);
    expect(registry.resolveHarness('shell')).toBeUndefined();
    expect(registry.listHarnesses({ status: 'unavailable' })).toHaveLength(1);
    expect(registry.updateHarnessStatus('ghost', 'retired')).toBe(false);
  });

  it('keeps registered descriptors immutable', () => {
    const registry = createExternalHarnessRegistry();
    registry.registerHarness(acpHarness);
    const stored = registry.getHarness('openhands-acp') as HarnessDescriptor;
    expect(Object.isFrozen(stored)).toBe(true);
  });
});
