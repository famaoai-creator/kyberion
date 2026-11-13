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
        note: 'Session-based bindings must be resolved by the channel gateway or interactive control surface.',
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
