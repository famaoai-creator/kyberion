import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

function readRepoFile(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

describe('Presence Studio OS control-plane route contract', () => {
  it('uses the canonical governed standard-intent catalog for the surface list', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');
    const routeStart = source.indexOf("presenceStudioData.app.get('/api/standard-intents'");
    const routeEnd = source.indexOf("presenceStudioData.app.get('/api/", routeStart + 1);
    const route = source.slice(routeStart, routeEnd === -1 ? undefined : routeEnd);

    expect(source).toContain(
      "import { loadStandardIntentCatalog } from '@agent/core/intent-resolution'"
    );
    expect(route).toContain('loadStandardIntentCatalog()');
    expect(route).not.toContain('readJson');
  });

  it('resolves server-side authority and propagates it to every OS operation', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');
    const routeStart = source.indexOf("presenceStudioData.app.get('/api/os/control-plane'");
    const decisionRouteStart = source.indexOf(
      "presenceStudioData.app.post('/api/os/held-actions/:actionId/decision'"
    );
    const applyRouteStart = source.indexOf(
      "presenceStudioData.app.post('/api/os/held-actions/:actionId/apply'"
    );
    const route = source.slice(routeStart, decisionRouteStart);
    const decisionRoute = source.slice(decisionRouteStart, applyRouteStart);
    const applyRoute = source.slice(applyRouteStart);

    expect(route).toContain('resolvePresenceStudioViewerContext(req)');
    expect(route).toContain('cloudflareOsSurface.snapshot(');
    expect(route).toContain("res.setHeader('Cache-Control', 'private, no-store')");
    expect(route).toContain(
      "typeof rawMissionId === 'string' ? rawMissionId : undefined,\n      access"
    );
    expect(route).not.toContain('error: error?.message || String(error)');
    expect(decisionRoute).toMatch(/decideHeldAction\(\s*actionId,\s*decision,\s*access\s*\)/u);
    expect(decisionRoute).toContain('readPresenceStudioRouteParam(req.params.actionId)');
    expect(decisionRoute).toContain(
      "safeParsePresenceStudioRequestBody(req.body, 'held action decision body')"
    );
    expect(applyRoute).toContain('applyHeldAction(actionId, access)');
    expect(applyRoute).toContain('readPresenceStudioRouteParam(req.params.actionId)');
    expect(applyRoute).toContain('res.status(502).json({');
  });

  it('keeps the operator UI aware of failure status and external-effect confirmation', () => {
    const source = readRepoFile('presence/displays/presence-studio/static/index.html');

    expect(source).toContain('id="os-control-plane-status"');
    expect(source).toContain('function fetchOsMutation(url, options)');
    expect(source).toContain('if (!response.ok || body.ok === false)');
    expect(source).toContain('if (!osControlPlaneResponse.ok || osControlPlaneBody?.ok === false)');
    expect(source).toContain('window.confirm(uiText(');
    expect(source).toContain('item.failureRecorded');
    expect(source).not.toContain('item.applyError');
  });

  it('renders the voice intent-resolution contract in the operator view', () => {
    const source = readRepoFile('presence/displays/presence-studio/static/index.html');

    expect(source).toContain('id="intent-resolution"');
    expect(source).toContain('renderIntentResolution(body.intentResolution)');
    expect(source).toContain('function parseIntentResolutionContract(value)');
    expect(source).toContain('contract = parseIntentResolutionContract(contract)');
    expect(source).toContain('Object.keys(value)');
    expect(source).toContain('item.normalized_intent');
    expect(source).toContain('item.authority_level');
    expect(source).toContain('item.outcome_kind');
    expect(source).toContain('nextAction.consequence');
    expect(source).toContain('authorityLabels[item.authority_level]');
    expect(source).toContain('outcomeLabels[item.outcome_kind]');
  });

  it('does not rewrite the governed voice-consent evidence when recording starts', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');

    expect(source).not.toContain("operator_handle: 'presence-studio-user'");
  });

  it('validates A2UI messages through the shared safe JSON boundary', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');
    const routeStart = source.indexOf("presenceStudioData.app.post('/a2ui/dispatch'");
    const routeEnd = source.indexOf("presenceStudioData.app.post('/api/voice/stimuli'", routeStart);
    const route = source.slice(routeStart, routeEnd);

    expect(source).toContain('import { appendJsonLine, nowIso, parseSafeJsonObjectValue }');
    expect(route).toContain('parseSafeJsonObjectValue(message, `A2UI message[${index}]`)');
    expect(route).toContain('presenceStudioData.presenceStudioWireError(error, 400)');
  });

  it('validates onboarding JSON before preview or apply reaches the domain parser', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');
    expect(source).toContain(
      "parseSafeJsonObjectValue(req.body ?? {}, 'browser onboarding preview body')"
    );
    expect(source).toContain(
      "parseSafeJsonObjectValue(req.body ?? {}, 'browser onboarding apply body')"
    );
  });

  it('validates timeline JSON before scheduling presence events', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');
    const routeStart = source.indexOf("presenceStudioData.app.post('/api/timeline/dispatch'");
    const routeEnd = source.indexOf("presenceStudioData.app.get('/api/stimuli/tail'", routeStart);
    const route = source.slice(routeStart, routeEnd);

    expect(route).toContain(
      "parseSafeJsonObjectValue(req.body ?? {}, 'presence timeline request')"
    );
    expect(route).toContain('validatePresenceTimeline(');
    expect(route).toContain('presenceStudioData.presenceStudioWireError(error, 400)');
  });

  it('normalizes every schema-backed request body before validation', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');
    expect(source).toContain('function safeParsePresenceStudioRequestBody(');
    expect(source).not.toMatch(/safeParse\(req\.body\)/u);
    expect(source).not.toContain('req.body?.goal_summary');
    expect(source).not.toContain('req.body?.success_condition');
  });
});
