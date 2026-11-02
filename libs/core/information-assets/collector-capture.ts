import * as path from 'node:path';
import { dotStatePath } from '../dot/dot-state-paths.js';
import { pathResolver } from '../path-resolver.js';
import { getSecretResolver, installSecretResolverIfAvailable } from '../secret/secret-resolver.js';
import { createScratchWorkspace, releaseWorkspace } from '../workforce/workspace-ledger.js';
import { resolveStorageFloor } from '../storage-layout.js';
import { safeRmSync } from '../secure-io.js';
import { withTaskCredentialBinding } from '../foundation/credential-binding.js';
import { assertReadOnlyServiceCapture } from '../service/service-capture-admission.js';
import { executeServicePreset } from '../service/service-engine.js';
import {
  issueScopedServiceCaptureAdmission,
  type ScopedServiceCaptureTransport,
} from '../service/service-capture-admission.js';
import { authorizeInformationAssetCapture } from './catalog.js';
import { assertCurrentInformationAssetScope, assertInformationAssetBinding } from './access.js';
import { loadServiceBindingRecord } from '../service/service-binding-registry.js';
import { getServiceEndpointRecord } from '../service/service-endpoint-registry.js';
import {
  credentialExecutionIdentity,
  hasTaskCredentialBinding,
  resolveTaskCredential,
  resolveTaskProviderEnvironment,
} from '../foundation/credential-binding.js';
import { assertIsolatedProviderHome } from '../provider/provider-auth-home.js';
import { buildSafeExecEnv } from '../secure-io.js';
import { parseSafeJsonObjectInput } from '../foundation/json.js';
import type { ServiceBinding } from '../service/service-binding.js';
import type { InformationAssetLocation, InformationAssetServiceRequest } from './types.js';

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}
function assertTarget(
  location: InformationAssetLocation,
  request: InformationAssetServiceRequest,
  target: string
): void {
  const vars = record(request.params.vars);
  if (location.service_id === 'github') {
    const expected = String(location.selectors.owner) + '/' + String(location.selectors.repo);
    if (target !== expected) throw new Error('information_asset_binding_target_mismatch');
    const query = record(request.params.query);
    const values =
      typeof query.variables === 'string'
        ? (parseSafeJsonObjectInput(query.variables, 'capture GraphQL variables') ?? {})
        : vars;
    if (values.owner !== location.selectors.owner || values.repo !== location.selectors.repo)
      throw new Error('information_asset_request_target_mismatch');
  } else if (location.service_id === 'jira') {
    const expected = String(location.selectors.domain);
    if (
      ![expected, expected + '.atlassian.net', 'https://' + expected + '.atlassian.net'].includes(
        target
      ) ||
      vars.domain !== expected
    )
      throw new Error('information_asset_binding_target_mismatch');
  } else if (location.service_id === 'google-workspace') {
    if (target !== 'me' || record(request.params.params).userId !== 'me')
      throw new Error('information_asset_binding_target_mismatch');
  } else throw new Error('information_asset_bound_transport_unsupported');
}
async function captureTransport(
  location: InformationAssetLocation,
  request: InformationAssetServiceRequest,
  rootDir?: string
): Promise<ScopedServiceCaptureTransport> {
  const current = await authorizeInformationAssetCapture(
    location.scope,
    location.location_id,
    request.action,
    { rootDir }
  );
  if (JSON.stringify(current) !== JSON.stringify(location))
    throw new Error('information_asset_capture_location_changed');
  const loaded = loadServiceBindingRecord(location.binding_id);
  const selected = loaded ? structuredClone(loaded) : undefined;
  if (!selected || selected.service_id !== location.service_id || !selected.auth_mode)
    throw new Error('information_asset_capture_bound_transport_missing');
  assertTarget(location, request, selected.target);
  if (
    location.service_id === 'google-workspace' &&
    !['session', 'secret-guard'].includes(selected.auth_mode)
  )
    throw new Error('information_asset_capture_isolated_session_required');
  const binding: ServiceBinding = {
    serviceId: location.service_id,
    authMode: selected.auth_mode,
    metadata: {
      binding_id: selected.binding_id,
      target: selected.target,
      tenant_slug: selected.tenant_slug,
    },
  };
  let providerEnvironment: Record<string, string> | undefined;
  if (selected.auth_mode === 'secret-guard') {
    if (!hasTaskCredentialBinding())
      throw new Error('information_asset_capture_credential_binding_required');
    const endpoint = getServiceEndpointRecord(location.service_id);
    if (!endpoint || selected.secret_refs.length === 0)
      throw new Error('information_asset_capture_secret_refs_required');
    const fieldMap = new Map<string, keyof ServiceBinding>();
    if (location.service_id === 'google-workspace')
      fieldMap.set('GOOGLE_WORKSPACE_CLI_TOKEN', 'accessToken');
    for (const field of [
      'accessToken',
      'basicAuthToken',
      'appToken',
      'refreshToken',
      'clientId',
      'clientSecret',
      'redirectUri',
    ] as const)
      for (const suffix of endpoint.credential_suffixes[field] ?? [])
        fieldMap.set(
          location.service_id.toUpperCase() + '_' + suffix,
          field === 'basicAuthToken' ? 'accessToken' : field
        );
    for (const ref of selected.secret_refs) {
      const field = fieldMap.get(ref);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) || !field || binding[field] !== undefined)
        throw new Error('information_asset_capture_secret_ref_unsupported');
      const value = resolveTaskCredential(ref);
      if (!value) throw new Error('information_asset_capture_bound_secret_missing');
      Object.defineProperty(binding, field, {
        enumerable: true,
        get: () => {
          assertInformationAssetBinding(location, request.action);
          const latest = loadServiceBindingRecord(location.binding_id);
          if (
            JSON.stringify(latest) !== JSON.stringify(selected) ||
            resolveTaskCredential(ref) !== value
          )
            throw new Error('information_asset_capture_binding_revoked');
          return value;
        },
      });
    }

    if (location.service_id === 'google-workspace') {
      const env = resolveTaskProviderEnvironment('gws');
      if (!env || !binding.accessToken)
        throw new Error('information_asset_capture_gws_token_environment_required');
      assertIsolatedProviderHome(env, location.scope.tenant_slug);
      const ambient = buildSafeExecEnv();
      providerEnvironment = Object.fromEntries(Object.keys(ambient).map((key) => [key, '']));
      for (const key of ['PATH', 'LANG', 'LC_ALL', 'TERM'])
        if (ambient[key]) providerEnvironment[key] = ambient[key]!;
      Object.assign(
        providerEnvironment,
        Object.fromEntries(
          Object.entries(env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        ),
        { GOOGLE_WORKSPACE_CLI_TOKEN: binding.accessToken }
      );
    }
  } else if (selected.auth_mode === 'session') {
    if (!hasTaskCredentialBinding())
      throw new Error('information_asset_capture_session_binding_required');
    const env = resolveTaskProviderEnvironment('gws');
    if (location.service_id !== 'google-workspace' || !env)
      throw new Error('information_asset_capture_session_unsupported');
    assertIsolatedProviderHome(env, location.scope.tenant_slug);
    const ambient = buildSafeExecEnv();
    providerEnvironment = Object.fromEntries(Object.keys(ambient).map((key) => [key, '']));
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'TERM'])
      if (ambient[key]) providerEnvironment[key] = ambient[key]!;
    Object.assign(
      providerEnvironment,
      Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    );
  } else if (selected.secret_refs.length > 0)
    throw new Error('information_asset_capture_auth_mode_mismatch');
  if (credentialExecutionIdentity().tenantSlug !== location.scope.tenant_slug)
    throw new Error('information_asset_capture_credential_scope_mismatch');
  return {
    binding,
    connection: {},
    providerEnvironment,
    validate: () => {
      assertCurrentInformationAssetScope(location.scope);
      assertInformationAssetBinding(location, request.action);
      if (
        JSON.stringify(loadServiceBindingRecord(location.binding_id)) !== JSON.stringify(selected)
      )
        throw new Error('information_asset_capture_binding_revoked');
      if (providerEnvironment) {
        const currentEnv = resolveTaskProviderEnvironment('gws');
        if (!currentEnv) throw new Error('information_asset_capture_session_revoked');
        assertIsolatedProviderHome(currentEnv, location.scope.tenant_slug);
        for (const [key, value] of Object.entries(currentEnv))
          if (providerEnvironment[key] !== value)
            throw new Error('information_asset_capture_session_revoked');
      }
    },
  };
}
export async function issueInformationAssetCaptureAdmission(
  location: InformationAssetLocation,
  request: InformationAssetServiceRequest,
  rootDir?: string
): Promise<object> {
  if (request.service_id !== location.service_id)
    throw new Error('information_asset_capture_scope_denied');
  const snapshotLocation = structuredClone(location);
  const snapshotRequest = structuredClone(request);
  return issueScopedServiceCaptureAdmission(snapshotRequest, () =>
    captureTransport(snapshotLocation, snapshotRequest, rootDir)
  );
}

/** Existing configured broker only: no task-claim fabrication and no ambient secret fallback. */
async function withCaptureBrokerCredentials<T>(
  location: InformationAssetLocation,
  request: InformationAssetServiceRequest,
  run: () => Promise<T>,
  rootDir?: string
): Promise<T> {
  if (hasTaskCredentialBinding()) return run();
  const current = await authorizeInformationAssetCapture(
    location.scope,
    location.location_id,
    request.action,
    { rootDir }
  );
  if (JSON.stringify(current) !== JSON.stringify(location))
    throw new Error('information_asset_capture_location_changed');
  const selected = loadServiceBindingRecord(location.binding_id);
  if (!selected || !selected.auth_mode)
    throw new Error('information_asset_capture_bound_transport_missing');
  assertTarget(location, request, selected.target);
  if (selected.auth_mode === 'none') return run();
  // Session-only task broker environments remain usable; standalone capture uses a scoped access token.
  if (selected.auth_mode === 'session')
    throw new Error('information_asset_capture_session_requires_broker_task_environment');
  if (!getSecretResolver()) installSecretResolverIfAvailable();
  const resolver = getSecretResolver();
  if (!resolver) throw new Error('information_asset_capture_credential_broker_unavailable');
  const endpoint = getServiceEndpointRecord(location.service_id);
  const allowed = new Set<string>();
  for (const suffixes of Object.values(endpoint?.credential_suffixes ?? {}))
    for (const suffix of suffixes) allowed.add(location.service_id.toUpperCase() + '_' + suffix);
  if (location.service_id === 'google-workspace') allowed.add('GOOGLE_WORKSPACE_CLI_TOKEN');
  if (
    selected.secret_refs.length === 0 ||
    selected.secret_refs.some((ref) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) || !allowed.has(ref))
  )
    throw new Error('information_asset_capture_secret_ref_unsupported');
  const selectedBytes = JSON.stringify(selected);
  const validate = () => {
    assertCurrentInformationAssetScope(location.scope);
    assertInformationAssetBinding(location, request.action);
    if (JSON.stringify(loadServiceBindingRecord(location.binding_id)) !== selectedBytes)
      throw new Error('information_asset_capture_binding_revoked');
  };
  const secrets: Record<string, string> = {};
  for (const key of selected.secret_refs) {
    validate();
    let value: string | null;
    try {
      value = await resolver.resolve({
        key,
        scope: location.scope.tenant_slug + '/service-bindings/' + location.binding_id,
        operation: 'information_asset.capture',
      });
    } catch {
      throw new Error('information_asset_capture_credential_broker_failed');
    }
    if (typeof value !== 'string' || !value || value.length > 16384)
      throw new Error('information_asset_capture_bound_secret_missing');
    secrets[key] = value;
  }
  validate();
  let workspace: ReturnType<typeof createScratchWorkspace> | undefined;
  let workspaceOptions: Parameters<typeof createScratchWorkspace>[1];
  const providerEnvironments: Record<string, NodeJS.ProcessEnv> = {};
  if (location.service_id === 'google-workspace') {
    if (!secrets.GOOGLE_WORKSPACE_CLI_TOKEN)
      throw new Error('information_asset_capture_gws_token_required');
    const root = resolveStorageFloor(
      'scratch',
      { kind: 'tier', tenant: location.scope.tenant_slug, tier: location.tier },
      'information-asset-capture'
    );
    workspaceOptions = {
      root,
      allowedRoots: [root],
      ledgerPath: path.join(
        rootDir ?? pathResolver.rootDir(),
        dotStatePath(
          { scope: { ...location.scope, tier: 'confidential' } },
          'information-assets',
          'credential-workspaces.json'
        )
      ),
    };
    workspace = createScratchWorkspace({}, workspaceOptions);
    providerEnvironments.gws = {
      HOME: workspace.path,
      GOOGLE_WORKSPACE_CLI_CONFIG_DIR: workspace.path,
      GOOGLE_WORKSPACE_CLI_TOKEN: secrets.GOOGLE_WORKSPACE_CLI_TOKEN,
    };
  }
  try {
    return await withTaskCredentialBinding(
      {
        tenantSlug: location.scope.tenant_slug,
        secrets,
        validate,
        ...(workspace ? { providerEnvironments } : {}),
      },
      run
    );
  } finally {
    if (workspace) {
      safeRmSync(workspace.path, { recursive: true, force: true });
      releaseWorkspace(workspace.id, workspaceOptions);
    }
  }
}
/** Exact scoped read: the selected binding determines credentials, target and auth mode. */
export async function executeInformationAssetCapture(
  location: InformationAssetLocation,
  request: InformationAssetServiceRequest,
  options: { rootDir?: string } = {}
): Promise<unknown> {
  if (request.service_id !== location.service_id)
    throw new Error('information_asset_capture_scope_denied');
  assertReadOnlyServiceCapture(request.service_id, request.action);
  const snapshotLocation = structuredClone(location);
  const snapshotRequest = structuredClone(request);
  return withCaptureBrokerCredentials(
    snapshotLocation,
    snapshotRequest,
    async () => {
      const capability = await issueInformationAssetCaptureAdmission(
        snapshotLocation,
        snapshotRequest,
        options.rootDir
      );
      return executeServicePreset(
        snapshotRequest.service_id,
        snapshotRequest.action,
        snapshotRequest.params,
        'secret-guard',
        undefined,
        undefined,
        undefined,
        capability
      );
    },
    options.rootDir
  );
}
