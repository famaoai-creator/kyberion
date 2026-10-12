import { describe, expect, it } from 'vitest';
import { SelectionRequestGate, selectionEndpoint } from '../src/lib/selection-contract';
import { parseSelectionCommand } from '../src/lib/selection-input';

describe('selection client request lifecycle', () => {
  it('only permits one in-flight request, including same-tick double saves', () => {
    const gate = new SelectionRequestGate();
    const first = gate.begin()!;
    expect(gate.begin()).toBeNull();
    expect(gate.accepts(first.version)).toBe(true);
    gate.complete(first.version);
    expect(gate.begin()).not.toBeNull();
  });
  it('cancel aborts pending preview and rejects its eventual response', () => {
    const gate = new SelectionRequestGate();
    const first = gate.begin()!;
    gate.cancel();
    expect(first.signal.aborted).toBe(true);
    expect(gate.accepts(first.version)).toBe(false);
    const second = gate.begin()!;
    expect(gate.accepts(second.version)).toBe(true);
    gate.complete(first.version);
    expect(gate.accepts(second.version)).toBe(true);
  });
  it('navigation invalidates earlier target responses before reload', () => {
    const gate = new SelectionRequestGate();
    const old = gate.begin()!;
    gate.cancel();
    const current = gate.begin()!;
    expect(gate.accepts(old.version)).toBe(false);
    expect(gate.accepts(current.version)).toBe(true);
  });
  it('constructs fixed same-origin endpoints and rejects URL/path injection', () => {
    expect(selectionEndpoint({ kind: 'reasoning' })).toBe('/api/reasoning/selection');
    expect(selectionEndpoint({ kind: 'mission', missionId: 'MSN-FIXTURE' })).toBe(
      '/api/missions/MSN-FIXTURE/selection'
    );
    for (const missionId of [
      'https://evil.example',
      '../MSN-X',
      '//evil.example',
      'MSN-X?tenant=other',
      'MSN-X\\evil',
    ])
      expect(() => selectionEndpoint({ kind: 'mission', missionId })).toThrow();
  });
});
describe('selection body contracts', () => {
  const input = {
    action: 'preview',
    role: 'planner',
    expectedRevision: '2',
    selection: { mode: 'fixed', runtime_mode: 'stub' },
  };
  it('keeps fixed model optional and never mixes agent identity into runtime settings', () => {
    expect(parseSelectionCommand(input, 'reasoning')?.selection).toEqual(input.selection);
    expect(
      parseSelectionCommand(
        { ...input, selection: { ...input.selection, agent_id: 'agent-one' } },
        'reasoning'
      )
    ).toBeNull();
  });
  it('requires a concrete runtime for preferred/fixed and strips nothing silently', () => {
    expect(
      parseSelectionCommand({ ...input, selection: { mode: 'fixed' } }, 'reasoning')
    ).toBeNull();
    expect(
      parseSelectionCommand(
        { ...input, selection: { mode: 'auto', provider: 'unexpected' } },
        'reasoning'
      )
    ).toBeNull();
    expect(
      parseSelectionCommand({ ...input, expected_scope: { tenant_slug: 'other' } }, 'reasoning')
    ).toBeNull();
  });
});
