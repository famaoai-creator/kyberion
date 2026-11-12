import * as allocations from '../governance/service-credential-allocation.js';
import { runInExecutionScope } from '../foundation/execution-scope.js';
import { withTaskCredentialBinding } from '../foundation/credential-binding.js';
import * as registry from './service-binding-registry.js';
import path from 'node:path';
import AjvModule from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { compileSchemaFromPath } from '../schema-loader.js';
import {
  getServiceEndpointRecord,
  getServiceEndpointRecordForIntent,
  loadServiceEndpointsCatalog,
  resolveServiceBinding,
  resolveServiceIdForIntent,
} from './service-binding.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('service-binding', () => {
  const originalMissionId = process.env.MISSION_ID;
  const originalAuthorizedScope = process.env.AUTHORIZED_SCOPE;
  const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
  const originalSlackAppToken = process.env.SLACK_APP_TOKEN;
  const originalCanvaAccessToken = process.env.CANVA_ACCESS_TOKEN;
  const originalCanvaRefreshToken = process.env.CANVA_REFRESH_TOKEN;
  const originalCanvaClientId = process.env.CANVA_CLIENT_ID;
  const originalCanvaClientSecret = process.env.CANVA_CLIENT_SECRET;

  afterEach(() => {
    if (originalMissionId === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = originalMissionId;

    if (originalAuthorizedScope === undefined) delete process.env.AUTHORIZED_SCOPE;
    else process.env.AUTHORIZED_SCOPE = originalAuthorizedScope;

    if (originalSlackBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = originalSlackBotToken;

    if (originalSlackAppToken === undefined) delete process.env.SLACK_APP_TOKEN;
    else process.env.SLACK_APP_TOKEN = originalSlackAppToken;

    if (originalCanvaAccessToken === undefined) delete process.env.CANVA_ACCESS_TOKEN;
    else process.env.CANVA_ACCESS_TOKEN = originalCanvaAccessToken;

    if (originalCanvaRefreshToken === undefined) delete process.env.CANVA_REFRESH_TOKEN;
    else process.env.CANVA_REFRESH_TOKEN = originalCanvaRefreshToken;

    if (originalCanvaClientId === undefined) delete process.env.CANVA_CLIENT_ID;
    else process.env.CANVA_CLIENT_ID = originalCanvaClientId;

    if (originalCanvaClientSecret === undefined) delete process.env.CANVA_CLIENT_SECRET;
    else process.env.CANVA_CLIENT_SECRET = originalCanvaClientSecret;
  });

  it('returns a plain binding for none auth mode', () => {
    expect(resolveServiceBinding('slack')).toEqual({
      serviceId: 'slack',
      authMode: 'none',
    });
  });

  it('returns a session note for session auth mode', () => {
    const binding = resolveServiceBinding('chronos', 'session');
    expect(binding.authMode).toBe('session');
    expect(binding.metadata?.note).toContain('Session-based bindings');
  });

  it('resolves service tokens from environment for secret-guard mode', () => {
    process.env.MISSION_ID = 'MSN-SYSTEM-NEXUS-DISPATCH';
    process.env.AUTHORIZED_SCOPE = 'slack';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_APP_TOKEN = 'xapp-test-token';

    const binding = resolveServiceBinding('slack', 'secret-guard');
    expect(binding).toMatchObject({
      serviceId: 'slack',
      authMode: 'secret-guard',
      accessToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
    });
    expect(binding.metadata).toMatchObject({
      serviceScoped: true,
      hasAccessToken: true,
      hasAppToken: true,
    });
    expect(binding.secretReferences?.accessToken).toEqual([
      {
        env: 'SLACK_ACCESS_TOKEN',
        scope: 'slack',
        operation: 'service.binding',
      },
      {
        env: 'SLACK_BOT_TOKEN',
        scope: 'slack',
        operation: 'service.binding',
      },
      {
        env: 'SLACK_TOKEN',
        scope: 'slack',
        operation: 'service.binding',
      },
    ]);
  });

  it('resolves oauth-style service credentials for secret-guard mode', () => {
    process.env.MISSION_ID = 'MSN-SYSTEM-NEXUS-DISPATCH';
    process.env.AUTHORIZED_SCOPE = 'canva';
    process.env.CANVA_ACCESS_TOKEN = 'canva-access-token';
    process.env.CANVA_REFRESH_TOKEN = 'canva-refresh-token';
    process.env.CANVA_CLIENT_ID = 'client-id';
    process.env.CANVA_CLIENT_SECRET = 'cnvca-test-secret';

    const binding = resolveServiceBinding('canva', 'secret-guard');
    expect(binding).toMatchObject({
      serviceId: 'canva',
      authMode: 'secret-guard',
      accessToken: 'canva-access-token',
      refreshToken: 'canva-refresh-token',
      clientId: 'client-id',
      clientSecret: 'cnvca-test-secret',
    });
    expect(binding.metadata).toMatchObject({
      hasAccessToken: true,
      hasRefreshToken: true,
      hasClientId: true,
      hasClientSecret: true,
    });
  });

  it('throws when secret-guard binding has no secrets', () => {
    process.env.MISSION_ID = 'MSN-SYSTEM-NEXUS-DISPATCH';
    process.env.AUTHORIZED_SCOPE = 'slack';
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;

    expect(() => resolveServiceBinding('slack', 'secret-guard')).toThrow(
      'Access denied: no service binding secret found for "slack"'
    );
  });

  it('emits service binding records that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(
      pathResolver.rootDir(),
      'knowledge/product/schemas/service-binding-record.schema.json'
    );
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const binding = {
      binding_id: 'BIND-TEST-SCHEMA',
      service_type: 'github',
      scope: 'repository',
      target: 'org/repo',
      allowed_actions: ['read', 'pull_request'],
      secret_refs: ['vault://bindings/github/schema/token'],
      approval_policy: {
        pull_request: 'allowed',
        merge: 'approval_required',
      },
      service_id: 'github',
      auth_mode: 'secret-guard',
    };
    const valid = validate(binding);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('loads canonical service endpoint records from the directory', () => {
    const catalog = loadServiceEndpointsCatalog();
    expect(catalog.default_pattern).toBe('https://api.{service_id}.com/v1');
    expect(catalog.services.slack).toMatchObject({
      base_url: 'https://slack.com/api',
      preset_path: 'knowledge/product/orchestration/service-presets/slack.json',
      allow_stream_ingress: false,
    });
    expect(catalog.services.asana).toMatchObject({
      base_url: 'https://app.asana.com/api/1.0',
      preset_path: 'knowledge/product/orchestration/service-presets/asana.json',
    });

    expect(getServiceEndpointRecord('github')).toMatchObject({
      base_url: 'https://api.github.com',
      preset_path: 'knowledge/product/orchestration/service-presets/github.json',
    });
    expect(getServiceEndpointRecord('stripe')).toMatchObject({
      base_url: 'https://api.stripe.com/v1',
      preset_path: 'knowledge/product/orchestration/service-presets/stripe.json',
    });
  });

  it('resolves service endpoints from intent aliases', () => {
    expect(resolveServiceIdForIntent('generate-video')).toBe('media-generation');
    expect(resolveServiceIdForIntent('transcribe-audio')).toBe('whisper');
    expect(resolveServiceIdForIntent('live-voice')).toBe('meeting');
    expect(getServiceEndpointRecordForIntent('generate-video')).toMatchObject({
      preset_path: 'knowledge/product/orchestration/service-presets/media-generation.json',
      intent_aliases: expect.arrayContaining(['generate-video']),
    });
  });
});

describe('selected tenant service credentials', () => {
  const selected: registry.ServiceBindingRecord = {
    binding_id: 'binding-a',
    service_id: 'slack',
    service_type: 'chat',
    scope: 'tenant',
    target: 'workspace',
    owner_kind: 'organization',
    owner_ref: 'alpha',
    tenant_slug: 'alpha',
    auth_mode: 'secret-guard',
    secret_refs: ['SLACK_BOT_TOKEN'],
    allowed_actions: ['read'],
    approval_policy: { read: 'allowed' },
  };
  const provenance = { serviceBindingId: 'binding-a', serviceId: 'slack', sourceOwnerRef: 'alpha' };
  afterEach(() => vi.restoreAllMocks());
  const tenant = <T>(run: () => T): T =>
    runInExecutionScope({ tenantBound: true, tenantSlug: 'alpha' }, run);
  it('selects declared refs only and rechecks record, source and execution on cached getters', () => {
    const load = vi.spyOn(registry, 'loadServiceBindingRecord').mockReturnValue(selected);
    tenant(() =>
      withTaskCredentialBinding(
        {
          tenantSlug: 'alpha',
          secrets: { SLACK_BOT_TOKEN: 'chosen', SLACK_ACCESS_TOKEN: 'not-chosen' },
          secretProvenance: { SLACK_BOT_TOKEN: provenance },
        },
        () => {
          const result = resolveServiceBinding('slack', 'secret-guard', undefined, selected);
          expect(result.accessToken).toBe('chosen');
          expect(result.secretReferences?.accessToken?.map((ref) => ref.env)).toEqual([
            'SLACK_BOT_TOKEN',
          ]);
          load.mockReturnValue({ ...selected, target: 'changed' });
          expect(() => result.accessToken).toThrow('Selected service binding changed');
          load.mockReturnValue(selected);
          runInExecutionScope({ tenantBound: true, tenantSlug: 'beta' }, () => {
            expect(() => result.accessToken).toThrow('CREDENTIAL_OWNER_DENIED');
          });
        }
      )
    );
  });
  it('denies missing or another connection provenance without ambient fallback', () => {
    vi.spyOn(registry, 'loadServiceBindingRecord').mockReturnValue(selected);
    for (const secretProvenance of [
      undefined,
      { SLACK_BOT_TOKEN: { ...provenance, serviceBindingId: 'binding-b' } },
    ]) {
      tenant(() =>
        withTaskCredentialBinding(
          { tenantSlug: 'alpha', secrets: { SLACK_BOT_TOKEN: 'other' }, secretProvenance },
          () => {
            expect(() =>
              resolveServiceBinding('slack', 'secret-guard', undefined, selected)
            ).toThrow('CREDENTIAL_PROVENANCE_DENIED');
          }
        )
      );
    }
  });
  it('uses personal source only with a verified action allocation and matching grant provenance', () => {
    const personal = {
      ...selected,
      owner_kind: 'person' as const,
      owner_ref: 'user:alice',
      tenant_slug: undefined,
    };
    vi.spyOn(registry, 'loadServiceBindingRecord').mockReturnValue(personal);
    const check = vi
      .spyOn(allocations, 'assertServiceCredentialAllocation')
      .mockReturnValue({ grant_id: 'grant-1' } as ReturnType<
        typeof allocations.assertServiceCredentialAllocation
      >);
    tenant(() =>
      withTaskCredentialBinding(
        {
          tenantSlug: 'alpha',
          secrets: { SLACK_BOT_TOKEN: 'allocated' },
          secretProvenance: {
            SLACK_BOT_TOKEN: {
              ...provenance,
              sourceOwnerRef: 'user:alice',
              allocationGrantId: 'grant-1',
            },
          },
        },
        () => {
          const result = resolveServiceBinding('slack', 'secret-guard', undefined, personal, {
            tenant_slug: 'alpha',
            action: 'read',
          });
          expect(result.accessToken).toBe('allocated');
          expect(check).toHaveBeenCalledWith(
            personal,
            { tenant_slug: 'alpha', action: 'read' },
            { action: 'read' }
          );
          check.mockImplementation(() => {
            throw new Error('allocation revoked');
          });
          expect(() => result.accessToken).toThrow('allocation revoked');
        }
      )
    );
    check.mockReturnValue({ grant_id: 'grant-1' } as ReturnType<
      typeof allocations.assertServiceCredentialAllocation
    >);
    tenant(() =>
      withTaskCredentialBinding(
        {
          tenantSlug: 'alpha',
          secrets: { SLACK_BOT_TOKEN: 'allocated' },
          secretProvenance: { SLACK_BOT_TOKEN: { ...provenance, sourceOwnerRef: 'user:alice' } },
        },
        () => {
          expect(() =>
            resolveServiceBinding('slack', 'secret-guard', undefined, personal, {
              tenant_slug: 'alpha',
              action: 'read',
            })
          ).toThrow('CREDENTIAL_PROVENANCE_DENIED');
        }
      )
    );
  });

  it('denies undeclared refs and a binding for a different service before secret resolution', () =>
    tenant(() => {
      expect(() =>
        resolveServiceBinding('slack', 'secret-guard', undefined, {
          ...selected,
          secret_refs: ['GITHUB_TOKEN'],
        })
      ).toThrow('undeclared credential references');
      expect(() =>
        resolveServiceBinding('slack', 'secret-guard', undefined, {
          ...selected,
          service_id: 'github',
        })
      ).toThrow('incompatible');
    }));
});
