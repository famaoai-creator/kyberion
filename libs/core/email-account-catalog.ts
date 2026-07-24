import { safeExec } from './secure-io.js';

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

function gmailReady(): boolean {
  try {
    const parsed = JSON.parse(
      safeExec('gws', ['auth', 'status'], { timeoutMs: 5_000, maxOutputMB: 1 }) || '{}'
    );
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

export interface EmailAccountDescriptor {
  id: EmailAccountId;
  display_name: string;
  status: EmailAccountProviderCandidate['status'];
  selectable: boolean;
  reason: string;
  capabilities: EmailAccountOperation[];
}

const accountDescriptors = new Map<EmailAccountId, EmailAccountDescriptor>([
  [
    'gmail',
    {
      id: 'gmail',
      display_name: 'Gmail',
      status: 'needs_setup',
      selectable: true,
      reason: 'Authenticate Gmail before runtime use.',
      capabilities: [...EMAIL_CAPABILITIES],
    },
  ],
  [
    'outlook',
    {
      id: 'outlook',
      display_name: 'Outlook / Microsoft 365',
      status: 'needs_setup',
      selectable: true,
      reason: 'Authenticate Microsoft 365 CLI before runtime use.',
      capabilities: [...EMAIL_CAPABILITIES],
    },
  ],
  [
    'yahoo',
    {
      id: 'yahoo',
      display_name: 'Yahoo Mail',
      status: 'needs_setup',
      selectable: false,
      reason: 'Yahoo Mail needs an OAuth/IMAP connector before runtime use.',
      capabilities: [...EMAIL_CAPABILITIES],
    },
  ],
]);

export function registerEmailAccountProvider(descriptor: EmailAccountDescriptor): void {
  accountDescriptors.set(descriptor.id, {
    ...descriptor,
    capabilities: [...descriptor.capabilities],
  });
}

export function listEmailAccountProviders(): EmailAccountProviderCandidate[] {
  const gmailIsReady = gmailReady();
  return [...accountDescriptors.values()].map((descriptor) => {
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
