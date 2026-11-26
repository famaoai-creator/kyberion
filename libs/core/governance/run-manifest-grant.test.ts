import { describe, expect, it } from 'vitest';
import { compileRunManifest, runtimeShapedAuthoredParams } from '../pipeline/run-manifest.js';
import {
  parseRunManifestGrant,
  runManifestGrantsFor,
  verifyManifestEntryMatchesEffect,
  type RunManifestGrant,
} from './run-manifest-grant.js';

const STEPS = [
  { op: 'secret:get', params: { service: 'garoon', account: 'user', export_as: 'pw' } },
  { op: 'browser:goto', params: { url: 'https://g.example.com/cgi-bin/x' } },
  { op: 'browser:goto', params: { url: 'https://g.example.com/item?id={{id}}' } },
  {
    op: 'core:while',
    params: {
      max_iterations: 3,
      pipeline: [{ op: 'browser:evaluate', params: { script: 'document.title' } }],
    },
  },
  { op: 'browser:fill', params: { selector: '#password', text: '{{pw}}' } },
];

const manifest = compileRunManifest(STEPS, {
  inputPath: 'knowledge/confidential/acme/scenarios/x.json',
  contentSha256: 'c'.repeat(64),
  scope: { tier: 'confidential', tenantSlug: 'acme' },
});
const grants = runManifestGrantsFor(manifest);
const grant = (id: string): RunManifestGrant => {
  const found = grants.find((entry) => entry.entry_id === id);
  if (!found) throw new Error(`no grant ${id}`);
  return found;
};

/** The effect shape the browser runtime hands to runExternalOperation. */
function effect(currentUrl: string, requested: Record<string, unknown>, resolved = requested) {
  return {
    session_scope: 'scope',
    tab_id: 'tab-1',
    current_url: currentUrl,
    requested_params: requested,
    params: resolved,
  };
}

describe('runManifestGrantsFor', () => {
  it('emits one strict grant per bindable entry with secret origins', () => {
    expect(grants.map((entry) => entry.entry_id)).toEqual(['1', '2', '3.pipeline.0', '4']);
    expect(grant('4').secret_origins).toEqual({ 'garoon/user': ['https://g.example.com'] });
    for (const entry of grants) expect(parseRunManifestGrant(entry)).toEqual(entry);
    expect(parseRunManifestGrant({ ...grant('1'), extra: true })).toBeUndefined();
    expect(parseRunManifestGrant({ ...grant('1'), target: undefined })).toBeUndefined();
  });
});

describe('verifyManifestEntryMatchesEffect', () => {
  it('admits a static navigation to the exact approved URL', () => {
    const params = { url: 'https://g.example.com/cgi-bin/x' };
    expect(
      verifyManifestEntryMatchesEffect(grant('1'), effect('about:blank', params), {
        operationId: 'browser:goto',
        occurrence: 1,
      })
    ).toEqual({ ok: true });
    expect(
      verifyManifestEntryMatchesEffect(grant('1'), effect('about:blank', params), {
        operationId: 'browser:evaluate',
        occurrence: 1,
      }).ok
    ).toBe(false);
  });

  it('admits runner-resolved params only as an instantiation of the approved template', () => {
    const authored = runtimeShapedAuthoredParams('browser:goto', STEPS[2]);
    const ok = { url: 'https://g.example.com/item?id=42' };
    expect(
      verifyManifestEntryMatchesEffect(grant('2'), effect('about:blank', ok), {
        operationId: 'browser:goto',
        occurrence: 1,
        authoredParams: authored,
      })
    ).toEqual({ ok: true });
    // Without the authored template the resolved params do not hash to the grant.
    expect(
      verifyManifestEntryMatchesEffect(grant('2'), effect('about:blank', ok), {
        operationId: 'browser:goto',
        occurrence: 1,
      })
    ).toEqual({ ok: false, reason: 'params differ from the approved step' });
    // A forged template with a different hash is refused.
    expect(
      verifyManifestEntryMatchesEffect(grant('2'), effect('about:blank', ok), {
        operationId: 'browser:goto',
        occurrence: 1,
        authoredParams: { url: '{{anything}}' },
      }).ok
    ).toBe(false);
    // The template matches but the destination leaves the approved origin.
    const elsewhere = { url: 'https://evil.example/item?id=1' };
    expect(
      verifyManifestEntryMatchesEffect(grant('2'), effect('about:blank', elsewhere), {
        operationId: 'browser:goto',
        occurrence: 1,
        authoredParams: authored,
      }).ok
    ).toBe(false);
  });

  it('confines page scripts to the approved origins and occurrence bound', () => {
    const params = { script: 'document.title' };
    const options = { operationId: 'browser:evaluate', occurrence: 3 };
    expect(
      verifyManifestEntryMatchesEffect(
        grant('3.pipeline.0'),
        effect('https://g.example.com/cgi-bin/x', params),
        options
      )
    ).toEqual({ ok: true });
    expect(
      verifyManifestEntryMatchesEffect(
        grant('3.pipeline.0'),
        effect('https://redirected.example/', params),
        options
      )
    ).toEqual({ ok: false, reason: 'current page origin is not an approved origin' });
    expect(
      verifyManifestEntryMatchesEffect(
        grant('3.pipeline.0'),
        effect('https://g.example.com/cgi-bin/x', params),
        { ...options, occurrence: 4 }
      )
    ).toEqual({ ok: false, reason: 'occurrence 4 exceeds the approved 3' });
    expect(
      verifyManifestEntryMatchesEffect(
        grant('3.pipeline.0'),
        effect('https://g.example.com/cgi-bin/x', { script: 'fetch("https://evil")' }),
        options
      ).ok
    ).toBe(false);
  });

  it('types a secret only on the origins approved for it', () => {
    const authored = runtimeShapedAuthoredParams('browser:fill', STEPS[4]);
    const resolved = { selector: '#password', text: 'hunter2' };
    const options = { operationId: 'browser:fill', occurrence: 1, authoredParams: authored };
    expect(
      verifyManifestEntryMatchesEffect(
        grant('4'),
        effect('https://g.example.com/login', resolved),
        options
      )
    ).toEqual({ ok: true });
    const narrowed: RunManifestGrant = {
      ...grant('4'),
      origins: ['https://g.example.com', 'https://other.example.com'],
      secret_origins: { 'garoon/user': ['https://g.example.com'] },
    };
    expect(
      verifyManifestEntryMatchesEffect(
        narrowed,
        effect('https://other.example.com/login', resolved),
        options
      )
    ).toEqual({
      ok: false,
      reason: 'secret garoon/user may not be sent to https://other.example.com',
    });
  });

  it('grants a secret only the origin of its preceding navigation, not every manifest origin', () => {
    const steps = [
      { op: 'secret:get', params: { service: 'garoon', account: 'user', export_as: 'pw' } },
      { op: 'browser:goto', params: { url: 'https://login.example.com/' } },
      { op: 'browser:fill', params: { selector: '#password', text: '{{pw}}' } },
      { op: 'browser:goto', params: { url: 'https://other.example.com/' } },
    ];
    const compiled = compileRunManifest(steps, {
      inputPath: 'knowledge/confidential/acme/scenarios/y.json',
      contentSha256: 'c'.repeat(64),
      scope: { tier: 'confidential', tenantSlug: 'acme' },
    });
    const fill = runManifestGrantsFor(compiled).find((entry) => entry.entry_id === '2')!;
    expect(fill.origins).toEqual(['https://login.example.com', 'https://other.example.com']);
    expect(fill.secret_origins).toEqual({ 'garoon/user': ['https://login.example.com'] });
    const options = {
      operationId: 'browser:fill',
      occurrence: 1,
      authoredParams: runtimeShapedAuthoredParams('browser:fill', steps[2]),
    };
    const resolved = { selector: '#password', text: 'hunter2' };
    expect(
      verifyManifestEntryMatchesEffect(
        fill,
        effect('https://login.example.com/', resolved),
        options
      )
    ).toEqual({ ok: true });
    // The same fill after a redirect to the other approved site goes to per-step approval.
    expect(
      verifyManifestEntryMatchesEffect(
        fill,
        effect('https://other.example.com/', resolved),
        options
      )
    ).toMatchObject({ ok: false });
  });

  it('refuses a runner-resolved value that was resolved again (page text "{{secret_var}}")', () => {
    const authored = { selector: '#q', text: '{{query}}' };
    const steps = [
      { op: 'browser:goto', params: { url: 'https://g.example.com/' } },
      { op: 'browser:fill', params: authored },
    ];
    const compiled = compileRunManifest(steps, {
      inputPath: 'knowledge/confidential/acme/scenarios/z.json',
      contentSha256: 'c'.repeat(64),
      scope: { tier: 'confidential', tenantSlug: 'acme' },
    });
    const fill = runManifestGrantsFor(compiled).find((entry) => entry.entry_id === '1')!;
    const options = { operationId: 'browser:fill', occurrence: 1, authoredParams: authored };
    // The runner resolved {{query}} to page text that itself looks like a template.
    const requested = { selector: '#q', text: '{{secret_var}}' };
    expect(
      verifyManifestEntryMatchesEffect(fill, effect('https://g.example.com/', requested), options)
    ).toEqual({ ok: true });
    expect(
      verifyManifestEntryMatchesEffect(
        fill,
        effect('https://g.example.com/', requested, { selector: '#q', text: 'S3CRET' }),
        options
      )
    ).toEqual({ ok: false, reason: 'params were resolved again after the runner resolved them' });
  });
});
