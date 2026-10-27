import Anthropic from '@anthropic-ai/sdk';
import {
  assertCredentialOwner,
  credentialExecutionIdentity,
  resolveProviderApiCredential,
} from '../foundation/credential-binding.js';

const ANTHROPIC_API = 'https://api.anthropic.com';

/** The SDK otherwise merges ambient custom headers even with an explicit apiKey.
 * Its protected client options are reset for tenant clients before any request. */
class TenantAnthropicClient extends Anthropic {
  constructor(key: string) {
    super({
      apiKey: key,
      authToken: null,
      webhookKey: null,
      baseURL: ANTHROPIC_API,
      maxRetries: 0,
      logLevel: 'off',
    });
    this._options.defaultHeaders = {};
  }
  assertBoundConfiguration(key: string): void {
    if (
      this.apiKey !== key ||
      this.authToken !== null ||
      this.baseURL !== ANTHROPIC_API ||
      Object.keys(this._options.defaultHeaders ?? {}).length !== 0
    ) {
      throw new Error('[CREDENTIAL_OWNER_DENIED] Tenant SDK configuration changed');
    }
  }
}

/** Creator ownership and the exact bound key are revalidated at each send.
 * Opaque injected clients remain an operator-only seam; they cannot prove tenant auth. */
export function createAnthropicCredentialClient(
  options: { client?: Anthropic; operatorApiKey?: string } = {}
) {
  const owner = credentialExecutionIdentity();
  if (owner.tenantSlug && options.client) {
    throw new Error(
      '[CREDENTIAL_OWNER_DENIED] Tenant Anthropic clients must be built from bound credentials'
    );
  }
  const boundKey = owner.tenantSlug
    ? resolveProviderApiCredential(['ANTHROPIC_API_KEY'], '')
    : undefined;
  const client = boundKey
    ? new TenantAnthropicClient(boundKey)
    : (options.client ??
      new Anthropic(options.operatorApiKey ? { apiKey: options.operatorApiKey } : {}));
  return {
    client,
    tenantScoped: Boolean(owner.tenantSlug),
    assertBinding: () => {
      assertCredentialOwner(owner);
      if (owner.tenantSlug) {
        if (resolveProviderApiCredential(['ANTHROPIC_API_KEY'], '') !== boundKey) {
          throw new Error('[CREDENTIAL_OWNER_DENIED] Provider credential binding changed');
        }
        (client as TenantAnthropicClient).assertBoundConfiguration(boundKey!);
      }
    },
  };
}
