// AU-02/03 contract tests for the component host: registry ↔ manifest
// coherence, route wiring, the hearing projection as valid A2UI, and the
// static host scripts' safety rules (no innerHTML, no internal vocabulary).
import { describe, expect, it } from 'vitest';
import type express from 'express';
import { pathResolver, safeReadFile } from '@agent/core';
import { validateA2UIMessage } from '@agent/core/a2ui';
import {
  loadUiComponentRegistry,
  unknownComponentOperations,
} from '@agent/core/ui-component-registry';
import { buildPresenceHeadlessManifest } from './headless.js';
import { applyHearingTurn, createHearingRecord } from './hearing.js';
import { defaultCatalogScenario } from './hearing-routes.js';
import {
  FLOW_VOCABULARY_KEYS,
  describeComponentsForViewer,
  projectHearingFlow,
  registerComponentHostRoutes,
} from './component-host-routes.js';

function readRepoFile(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

function createFakeApp() {
  const handlers = new Map<string, unknown>();
  const fake = {
    get(routePath: string, handler: unknown) {
      handlers.set(`GET ${routePath}`, handler);
    },
    post(routePath: string, handler: unknown) {
      handlers.set(`POST ${routePath}`, handler);
    },
  };
  return { app: fake as unknown as express.Express, handlers };
}

describe('component host', () => {
  it('registers the host page and its three APIs', () => {
    const { app, handlers } = createFakeApp();
    registerComponentHostRoutes(app, '/tmp/static');
    expect([...handlers.keys()].sort()).toEqual([
      'GET /api/components',
      'GET /api/flow-vocabulary',
      'GET /api/headless/a2ui/hearing',
      'GET /flow/:component',
    ]);
  });

  it('every operation the registry claims is a real headless operation of the host manifest', () => {
    const known = new Set(buildPresenceHeadlessManifest().operations.map((op) => op.operation_id));
    expect(unknownComponentOperations(loadUiComponentRegistry(), known)).toEqual([]);
    expect(known.has('presence.components.read')).toBe(true);
  });

  it('describes components for a loopback owner with resolved labels and hrefs, never raw keys', () => {
    const described = describeComponentsForViewer(
      {
        principalId: 'human:presence-studio-localadmin',
        tenantSlugs: ['default'],
        source: 'loopback',
      },
      'ja'
    );
    expect(described.role).toBe('owner');
    const hearing = described.components.find((c) => c.id === 'hearing');
    expect(hearing).toMatchObject({
      status: 'a2ui',
      href: '/flow/hearing',
      a2ui_path: '/api/headless/a2ui/hearing',
      title: 'ヒアリング',
    });
    expect(hearing?.input?.operation_id).toBe('presence.hearing.answer');
    expect(JSON.stringify(described)).not.toMatch(/front_desk:/u);
    const approvals = described.components.find((c) => c.id === 'approvals');
    expect(approvals?.href).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
  });

  it('projects a phased hearing into valid A2UI with an input operation until decided', () => {
    let record = createHearingRecord('s-1', '2026-09-15T00:00:00.000Z', defaultCatalogScenario());
    record = applyHearingTurn(
      record,
      { text: '営業担当', request_id: 't1' },
      '2026-09-15T00:00:00.000Z'
    );
    const flow = projectHearingFlow(record, 's-1', 'ja');
    for (const message of flow.a2ui) expect(() => validateA2UIMessage(message)).not.toThrow();
    const components = flow.a2ui[1].updateComponents?.components ?? [];
    expect(components.map((c) => c.type)).toContain('display:progress');
    expect(components.filter((c) => c.type === 'display:section')).toHaveLength(3);
    expect(flow.input).toMatchObject({
      operation_id: 'presence.hearing.answer',
      method: 'POST',
      path: '/api/hearing/s-1/answer',
      body_field: 'text',
    });
    expect(flow.actions).toEqual([]);
    expect(JSON.stringify(flow)).not.toMatch(/front_desk:|hearing_req_/u);
  });

  it('host scripts never insert HTML strings and never leak internal vocabulary', () => {
    const host = readRepoFile('presence/displays/presence-studio/static/a2ui-host.js');
    const flow = readRepoFile('presence/displays/presence-studio/static/flow.js');
    const html = readRepoFile('presence/displays/presence-studio/static/flow.html');
    const combined = `${host}\n${flow}\n${html}`;
    expect(combined).not.toContain('innerHTML');
    expect(combined).not.toContain('target=');
    expect(combined).not.toContain('127.0.0.1');
    const stripped = combined.replace(/front_desk:[a-zA-Z0-9_]+/g, '');
    for (const word of ['mission', 'ADF', 'actuator', 'pipeline', 'stimuli', 'ports']) {
      expect(stripped.toLowerCase()).not.toContain(word.toLowerCase());
    }
    for (const key of FLOW_VOCABULARY_KEYS) expect(key).toMatch(/^front_desk:/u);
  });
});
