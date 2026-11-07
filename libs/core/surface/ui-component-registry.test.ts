import { describe, expect, it } from 'vitest';
import {
  findUiComponent,
  listUiComponents,
  loadUiComponentRegistry,
  roleCanSee,
  unknownComponentOperations,
} from './ui-component-registry.js';

describe('ui component registry', () => {
  it('ships the first flow (hearing) as an A2UI component with an input operation', () => {
    const hearing = findUiComponent('hearing');
    expect(hearing).toMatchObject({
      kind: 'flow',
      status: 'a2ui',
      host: 'presence-studio',
      entry: {
        a2ui_path: '/api/headless/a2ui/hearing',
        input: { operation_id: 'presence.hearing.answer' },
      },
    });
    for (const component of loadUiComponentRegistry().components) {
      expect(component.title_key).toMatch(/^front_desk:/u);
      expect(component.summary_key).toMatch(/^front_desk:/u);
    }
  });

  it('lists components in the five-verb order and filters by role/host/group', () => {
    const all = listUiComponents('owner');
    expect(all.map((c) => c.id)).toEqual(['hearing', 'approvals', 'decision-ledger', 'progress']);
    expect(listUiComponents('viewer', { host: 'presence-studio' }).map((c) => c.id)).toEqual([
      'hearing',
      'decision-ledger',
      'progress',
    ]);
    expect(listUiComponents('viewer', { group: 'decide' }).map((c) => c.id)).toEqual([
      'approvals',
      'decision-ledger',
    ]);
    expect(roleCanSee('viewer', 'owner')).toBe(false);
    expect(roleCanSee('approver', 'viewer')).toBe(true);
  });

  it('reports operations a component claims that no manifest declares', () => {
    const registry = loadUiComponentRegistry();
    const known = new Set([
      'presence.hearing.view.a2ui',
      'presence.hearing.answer',
      'presence.hearing.decide',
      'presence.hearing.handoff',
    ]);
    expect(unknownComponentOperations(registry, known)).toEqual([]);
    expect(unknownComponentOperations(registry, new Set(['presence.hearing.answer']))).toEqual([
      { component: 'hearing', operation_id: 'presence.hearing.view.a2ui' },
      { component: 'hearing', operation_id: 'presence.hearing.decide' },
      { component: 'hearing', operation_id: 'presence.hearing.handoff' },
    ]);
  });
});
