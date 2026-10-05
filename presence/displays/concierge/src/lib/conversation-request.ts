import {
  frontDeskArtifactRevisionCommand,
  parseFrontDeskArtifactRevisionInput,
  type ConversationHistoryMessage,
  type FrontDeskArtifactRevisionInput,
  type FrontDeskReceiptFormat,
} from '@agent/core/surface/front-desk-conversation-history';

export interface ConversationRequestScope {
  sessionId: string;
  tenant?: string;
  organizationId?: string;
  projectId?: string;
}
export interface PendingConversationRequest {
  id: string;
  text: string;
  createdAt: number;
  payload: ConversationRequestScope & {
    text: string;
    locale: string;
    requestId: string;
    requestCreatedAt: number;
    artifactRevision?: FrontDeskArtifactRevisionInput;
  };
}
const requestFields = new Set([
  'sessionId',
  'tenant',
  'organizationId',
  'projectId',
  'text',
  'locale',
  'requestId',
  'requestCreatedAt',
  'artifactRevision',
]);

export function sameConversationRequestScope(
  a: ConversationRequestScope,
  b: ConversationRequestScope
): boolean {
  return ['sessionId', 'tenant', 'organizationId', 'projectId'].every(
    (key) => a[key as keyof ConversationRequestScope] === b[key as keyof ConversationRequestScope]
  );
}

/** Select only a verified server version, never an ID or path inferred from prose. */
export function artifactRevisionForMessage(
  message: ConversationHistoryMessage | undefined,
  format: FrontDeskReceiptFormat
): FrontDeskArtifactRevisionInput | undefined {
  if (
    message?.role !== 'secretary' ||
    message.artifact?.canRevise !== true ||
    message.artifact.format === format
  )
    return undefined;
  return parseFrontDeskArtifactRevisionInput({
    requestId: message.artifact.requestId,
    revision: message.artifact.revision,
    sha256: message.artifact.sha256,
    format,
  });
}

export function sameArtifactRevision(
  a?: FrontDeskArtifactRevisionInput,
  b?: FrontDeskArtifactRevisionInput
): boolean {
  if (!a || !b) return a === b;
  return (
    a.requestId === b.requestId &&
    a.revision === b.revision &&
    a.sha256 === b.sha256 &&
    a.format === b.format
  );
}

/** Keep every POST field stable for retries, even if locale changes in the meantime. */
export function prepareConversationRequest(
  text: string,
  scope: ConversationRequestScope,
  locale: string,
  id: string,
  createdAt: number,
  pending: PendingConversationRequest | null,
  artifactRevision?: FrontDeskArtifactRevisionInput
): PendingConversationRequest {
  if (
    pending &&
    pending.text === text &&
    sameConversationRequestScope(pending.payload, scope) &&
    sameArtifactRevision(pending.payload.artifactRevision, artifactRevision)
  )
    return pending;
  return {
    id,
    text,
    createdAt,
    payload: {
      ...scope,
      text,
      locale,
      requestId: id,
      requestCreatedAt: createdAt,
      ...(artifactRevision ? { artifactRevision: { ...artifactRevision } } : {}),
    },
  };
}

/** Session storage can carry an inert retry payload, but no extra transport authority. */
export function parsePendingConversationRequest(
  value: unknown,
  scope: ConversationRequestScope,
  locale: string
): PendingConversationRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((key) => !['id', 'text', 'createdAt', 'payload'].includes(key)) ||
    typeof row.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(row.id) ||
    typeof row.text !== 'string' ||
    !row.text.trim() ||
    row.text.length > 8192 ||
    typeof row.createdAt !== 'number' ||
    !Number.isFinite(row.createdAt)
  )
    return undefined;
  // Existing text-only sessions can be safely upgraded. Revision retries require the whole payload.
  if (row.payload === undefined)
    return prepareConversationRequest(row.text, scope, locale, row.id, row.createdAt, null);
  if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload))
    return undefined;
  const payload = row.payload as Record<string, unknown>;
  if (
    Object.keys(payload).some((key) => !requestFields.has(key)) ||
    payload.text !== row.text ||
    payload.requestId !== row.id ||
    payload.requestCreatedAt !== row.createdAt ||
    typeof payload.locale !== 'string' ||
    !payload.locale ||
    typeof payload.sessionId !== 'string' ||
    ['tenant', 'organizationId', 'projectId'].some(
      (key) => payload[key] !== undefined && typeof payload[key] !== 'string'
    ) ||
    !sameConversationRequestScope(payload as unknown as ConversationRequestScope, scope)
  )
    return undefined;
  const artifactRevision = parseFrontDeskArtifactRevisionInput(payload.artifactRevision);
  if (
    payload.artifactRevision !== undefined &&
    (!artifactRevision || row.text !== frontDeskArtifactRevisionCommand(artifactRevision.format))
  )
    return undefined;
  return prepareConversationRequest(
    row.text,
    scope,
    payload.locale,
    row.id,
    row.createdAt,
    null,
    artifactRevision
  );
}
