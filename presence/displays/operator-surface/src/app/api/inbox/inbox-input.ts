export const INBOX_MUTATION_STATUSES = ['read', 'accepted', 'unread'] as const;

export type InboxMutationStatus = (typeof INBOX_MUTATION_STATUSES)[number];

export type InboxMutationInput = {
  entryId: string;
  status: InboxMutationStatus;
};

export type InboxMutationParseResult =
  { ok: true; value: InboxMutationInput } | { ok: false; error: string };

function isInboxMutationStatus(value: unknown): value is InboxMutationStatus {
  return (
    typeof value === 'string' && (INBOX_MUTATION_STATUSES as readonly string[]).includes(value)
  );
}

export function parseInboxMutationInput(value: unknown): InboxMutationParseResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Inbox request body must be a JSON object' };
  }

  const body = value as Record<string, unknown>;
  if (typeof body.entry_id !== 'string' || body.entry_id.length === 0) {
    return { ok: false, error: 'Missing inbox mutation payload' };
  }
  if (!isInboxMutationStatus(body.status)) {
    return { ok: false, error: 'Missing inbox mutation payload' };
  }

  return { ok: true, value: { entryId: body.entry_id, status: body.status } };
}

export function parseInboxMutationForm(form: FormData): InboxMutationParseResult {
  return parseInboxMutationInput({
    entry_id: form.get('entry_id'),
    status: form.get('status'),
  });
}
