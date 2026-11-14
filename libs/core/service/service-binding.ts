import { buildSafeExecEnv } from '../secure-io.js';
import { currentActor } from '../authn/actor-context.js';
import { assertIsolatedProviderHome } from '../provider/provider-auth-home.js';
import {
  assertServiceCredentialAllocation,
  type ServiceAllocationUseScope,
} from '../governance/service-credential-allocation.js';
import { loadServiceBindingRecord, type ServiceBindingRecord } from './service-binding-registry.js';
import type { ServiceAuthMode, CredentialSuffixKey } from './service-endpoint-registry.js';
export {
  getServiceEndpointRecord,
  getServiceEndpointRecordForIntent,
  loadServiceEndpointsCatalog,
  resolveServiceIdForIntent,
} from './service-endpoint-registry.js';
import {
  getServiceCredentialSuffixes,
  resolveServiceSecret,
  resolveSelectedServiceSecret,
  resolveServiceSecretReferences,
} from './service-secret-resolver.js';
import type { SecretReference } from '../secret/secret-resolver.js';
import {
  credentialExecutionIdentity,
  assertCredentialOwner,
  resolveTaskServiceProviderBinding,
  type TaskProviderProvenance,
} from '../foundation/credential-binding.js';

export interface ServiceBinding {
  serviceId: string;
  authMode: ServiceAuthMode;
  accessToken?: string;
  appToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  /** Non-sensitive env-name references retained for late-bound consumers. */
  secretReferences?: Partial<Record<CredentialSuffixKey, SecretReference[]>>;
  metadata?: Record<string, unknown>;
}

/** Request selectors remain stable; a trusted selected GWS record supplies its session transport. */
export function resolveServiceTransportAuth(
  serviceId: string,
  selector: 'none' | 'secret-guard',
  selected?: ServiceBindingRecord
): 'none' | 'secret-guard' | 'session' {
  return serviceId === 'google-workspace' &&
    selector === 'none' &&
    selected?.auth_mode === 'session'
    ? 'session'
    : selector;
}

export function resolveServiceBinding(
  serviceId: string,
  authMode: 'none' | 'secret-guard' | 'session' = 'none',
  credentialKeys?: readonly CredentialSuffixKey[],
  selectedBinding?: ServiceBindingRecord,
  allocationUse?: ServiceAllocationUseScope & { action: string }
): ServiceBinding {
  if (authMode === 'none') {
    return { serviceId, authMode };
  }

  if (authMode === 'session') {
    return {
      serviceId,
      authMode,
      metadata: {
        ...(serviceId === 'google-workspace' && credentialExecutionIdentity().tenantSlug
          ? { sessionProvenance: resolveSelectedGwsSessionProof(selectedBinding).provenance }
          : {
              note: 'Session-based bindings must be resolved by the channel gateway or interactive control surface.',
            }),
      },
    };
  }

  // Suffixes are catalog-governed (service-endpoints.schema.json defaults applied
  // on load); no hardcoded fallback literals live here.
  const suffixes = getServiceCredentialSuffixes(serviceId);
  const selection = selectedBinding ? structuredClone(selectedBinding) : undefined;
  if (
    selection &&
    (selection.auth_mode !== 'secret-guard' ||
      (selection.service_id || selection.service_type) !== serviceId ||
      !selection.owner_ref ||
      selection.secret_refs.length === 0 ||
      credentialExecutionIdentity().tenantSlug !==
        (selection.owner_kind === 'person' ? allocationUse?.tenant_slug : selection.tenant_slug))
  )
    throw new Error('[CREDENTIAL_PROVENANCE_DENIED] Selected service binding is incompatible');
  const knownRefs = new Set(
    Object.values(suffixes)
      .flat()
      .map((suffix) => resolveServiceSecretReferences(serviceId, [suffix])[0]!.env)
  );
  if (
    selection &&
    (new Set(selection.secret_refs).size !== selection.secret_refs.length ||
      selection.secret_refs.some((ref) => !knownRefs.has(ref)))
  ) {
    throw new Error(
      '[CREDENTIAL_PROVENANCE_DENIED] Selected binding has undeclared credential references'
    );
  }
  const selected = (key: CredentialSuffixKey): string[] => {
    const candidates = !credentialKeys || credentialKeys.includes(key) ? suffixes[key] || [] : [];
    return selection
      ? candidates.filter((suffix) =>
          selection.secret_refs.includes(
            resolveServiceSecretReferences(serviceId, [suffix])[0]!.env
          )
        )
      : candidates;
  };
  const read = (key: CredentialSuffixKey): string | null => {
    if (!selection) return resolveServiceSecret(serviceId, selected(key));
    if (
      JSON.stringify(loadServiceBindingRecord(selection.binding_id)) !== JSON.stringify(selection)
    ) {
      throw new Error('[CREDENTIAL_PROVENANCE_DENIED] Selected service binding changed');
    }
    const grant =
      selection.owner_kind === 'person'
        ? assertServiceCredentialAllocation(selection, allocationUse!, {
            action: allocationUse!.action,
          })
        : undefined;
    return resolveSelectedServiceSecret(serviceId, selected(key), {
      bindingId: selection.binding_id,
      ownerRef: selection.owner_ref!,
      secretRefs: selection.secret_refs,
      allocationGrantId: grant?.grant_id,
    });
  };
  const referenceOperation = 'service.binding';
  const referenceEntry = (key: string, candidates: string[]) => {
    const references = resolveServiceSecretReferences(serviceId, candidates, referenceOperation);
    return references.length > 0 ? { [key]: references } : {};
  };
  const secretReferences = {
    ...referenceEntry('accessToken', selected('accessToken')),
    ...referenceEntry('appToken', selected('appToken')),
    ...referenceEntry('refreshToken', selected('refreshToken')),
    ...referenceEntry('clientId', selected('clientId')),
    ...referenceEntry('clientSecret', selected('clientSecret')),
    ...referenceEntry('redirectUri', selected('redirectUri')),
  };
  const accessToken = read('accessToken');
  const appToken = read('appToken');
  const refreshToken = read('refreshToken');
  const clientId = read('clientId');
  const clientSecret = read('clientSecret');
  const redirectUri = read('redirectUri');

  if (!accessToken && !appToken && !refreshToken && !clientId && !clientSecret && !redirectUri) {
    throw new Error(`Access denied: no service binding secret found for "${serviceId}"`);
  }

  const binding: ServiceBinding = {
    serviceId,
    authMode,
    secretReferences,
    accessToken: accessToken || undefined,
    appToken: appToken || undefined,
    refreshToken: refreshToken || undefined,
    clientId: clientId || undefined,
    clientSecret: clientSecret || undefined,
    redirectUri: redirectUri || undefined,
    metadata: {
      serviceScoped: true,
      hasAccessToken: Boolean(accessToken),
      hasAppToken: Boolean(appToken),
      hasRefreshToken: Boolean(refreshToken),
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(clientSecret),
      hasRedirectUri: Boolean(redirectUri),
    },
  };
  const owner = credentialExecutionIdentity();
  const captured = { accessToken, appToken, refreshToken, clientId, clientSecret, redirectUri };
  // A cached service binding cannot carry another task's token into a later
  // request. Resolve again so a scoped revocation/miss never uses an old value.
  for (const key of [
    'accessToken',
    'appToken',
    'refreshToken',
    'clientId',
    'clientSecret',
    'redirectUri',
  ] as const) {
    Object.defineProperty(binding, key, {
      enumerable: true,
      configurable: false,
      get: () => {
        assertCredentialOwner(owner);
        return (owner.tenantSlug ? read(key) : captured[key]) ?? undefined;
      },
    });
  }
  return binding;
}

/** Internal session consumer shared by PRESET dispatch and exact-read asset capture. */
function resolveSelectedGwsSessionProof(selected?: ServiceBindingRecord): {
  environment: Record<string, string>;
  provenance: Readonly<TaskProviderProvenance>;
} {
  const tenant = credentialExecutionIdentity().tenantSlug;
  if (!tenant) throw new Error('[CREDENTIAL_PROVENANCE_DENIED] Tenant session scope required');
  const actor = currentActor();
  if (
    !selected ||
    selected.auth_mode !== 'session' ||
    selected.owner_kind !== 'organization' ||
    selected.tenant_slug !== tenant ||
    selected.owner_ref !== tenant ||
    (selected.service_id || selected.service_type) !== 'google-workspace' ||
    JSON.stringify(loadServiceBindingRecord(selected.binding_id)) !== JSON.stringify(selected) ||
    !actor ||
    actor.provenance !== 'claim' ||
    actor.scope.tenant_slug !== tenant
  ) {
    throw new Error(
      '[CREDENTIAL_PROVENANCE_DENIED] Tenant GWS requires its selected session and claim actor'
    );
  }
  const { environment: env, provenance } = resolveTaskServiceProviderBinding('gws', {
    serviceBindingId: selected.binding_id,
    serviceId: 'google-workspace',
    sourceOwnerRef: selected.owner_ref,
    actorId: actor.actor.id,
  });
  // Explicit config root prevents GWS from looking in a global/default session.
  if (
    env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR !== env.HOME ||
    Object.keys(env).some(
      (key) =>
        ![
          'HOME',
          'GOOGLE_WORKSPACE_CLI_CONFIG_DIR',
          'GOOGLE_WORKSPACE_CLI_TOKEN',
          'GOOGLE_APPLICATION_CREDENTIALS',
        ].includes(key)
    )
  ) {
    throw new Error('[CREDENTIAL_PROVENANCE_DENIED] Invalid isolated GWS session environment');
  }
  assertIsolatedProviderHome(env, tenant);
  return { environment: env as Record<string, string>, provenance };
}

/** Complete isolated process environment for the currently selected session proof. */
export function resolveSelectedGwsSessionEnvironment(
  selected?: ServiceBindingRecord
): Record<string, string> {
  const { environment: env } = resolveSelectedGwsSessionProof(selected);
  const ambient = buildSafeExecEnv();
  const isolated: Record<string, string> = Object.fromEntries(
    Object.keys(ambient).map((key) => [key, ''])
  );
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TERM'])
    if (ambient[key]) isolated[key] = ambient[key]!;
  return Object.assign(isolated, env) as Record<string, string>;
}
