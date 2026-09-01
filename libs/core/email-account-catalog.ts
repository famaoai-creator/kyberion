import { safeExec } from './secure-io.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from './seam.js';
import { parseSafeJsonObjectInput } from './foundation/safe-json.js';

/** Provider IDs are open-ended so a new account connector does not require a core type change. */
export type EmailAccountId = string;

export type EmailAccountOperation = 'send' | 'draft' | 'reply' | 'reply-all' | 'list' | 'archive';

export interface EmailAccountProviderCandidate {
  id: EmailAccountId;
  display_name: string;
  adapter_id: string;
  status: 'ready' | 'needs_setup' | 'unsupported';
  selectable: boolean;
  reason: string;
  capabilities: EmailAccountOperation[];
}

const EMAIL_CAPABILITIES: EmailAccountOperation[] = [
  'send',
  'draft',
  'reply',
  'reply-all',
  'list',
  'archive',
];

export function isGmailAuthStatusReady(raw: string): boolean {
  try {
    const parsed = parseSafeJsonObjectInput(raw, 'Gmail auth status');
    return Boolean(
      (parsed?.auth_method && parsed.auth_method !== 'none') ||
      parsed?.token_cache_exists ||
      parsed?.encrypted_credentials_exists ||
      parsed?.plain_credentials_exists
    );
  } catch {
    return false;
  }
}

function gmailReady(): boolean {
  return isGmailAuthStatusReady(
    safeExec('gws', ['auth', 'status'], { timeoutMs: 5_000, maxOutputMB: 1 }) || '{}'
  );
}

export interface EmailAccountDescriptor {
  id: EmailAccountId;
  display_name: string;
  status: EmailAccountProviderCandidate['status'];
  selectable: boolean;
  reason: string;
  capabilities: EmailAccountOperation[];
}

const emailAccountProviderSeam = createSeam<EmailAccountDescriptor>({
  key: 'email-account-provider',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

export function registerEmailAccountProvider(
  descriptor: EmailAccountDescriptor,
  metadata: SeamProviderMetadata = {
    provenance: 'builtin',
    source: 'libs/core/email-account-catalog.ts',
  }
): () => void {
  return emailAccountProviderSeam.register(
    descriptor.id,
    {
      ...descriptor,
      capabilities: [...descriptor.capabilities],
    },
    metadata
  );
}

export function listEmailAccountProviders(): EmailAccountProviderCandidate[] {
  const gmailIsReady = gmailReady();
  return emailAccountProviderSeam.list().map(({ implementation: descriptor }) => {
    const ready = descriptor.id === 'gmail' && gmailIsReady;
    return {
      ...descriptor,
      adapter_id: `email.account.${descriptor.id}`,
      status: ready ? 'ready' : descriptor.status,
      reason: ready ? 'Gmail account is authenticated and ready.' : descriptor.reason,
      capabilities: [...descriptor.capabilities],
    };
  });
}

registerEmailAccountProvider({
  id: 'gmail',
  display_name: 'Gmail',
  status: 'needs_setup',
  selectable: true,
  reason: 'Authenticate Gmail before runtime use.',
  capabilities: [...EMAIL_CAPABILITIES],
});
registerEmailAccountProvider({
  id: 'outlook',
  display_name: 'Outlook / Microsoft 365',
  status: 'needs_setup',
  selectable: true,
  reason: 'Authenticate Microsoft 365 CLI before runtime use.',
  capabilities: [...EMAIL_CAPABILITIES],
});
registerEmailAccountProvider({
  id: 'yahoo',
  display_name: 'Yahoo Mail',
  status: 'needs_setup',
  selectable: false,
  reason: 'Yahoo Mail needs an OAuth/IMAP connector before runtime use.',
  capabilities: [...EMAIL_CAPABILITIES],
});
