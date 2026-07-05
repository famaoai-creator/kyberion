import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getReasoningBackend } from './reasoning-backend.js';
import { executeServicePreset } from './service-engine.js';
import { pathResolver } from './path-resolver.js';
import { processUntrustedContent } from './untrusted-content.js';
import {
  safeExistsSync,
  safeExec,
  safeMkdir,
  safeReadFile,
  safeStat,
  safeWriteFile,
} from './secure-io.js';

export interface EmailDraftArtifact {
  exists: boolean;
  path: string;
  json_path: string;
  updated_at: string | null;
  to: string;
  subject: string;
  tone: string;
  body_markdown: string;
  draft_markdown: string;
  triage_path: string;
}

export interface EmailDraftGenerationInput {
  requestId?: string;
  recipient?: string;
  subjectInput?: string;
  tone?: string;
  triageText: string;
  delegateTask?: (prompt: string, taskId: string) => Promise<string>;
  backendName?: string;
}

export interface EmailDraftGenerationResult {
  request_id: string;
  backend: string;
  to: string;
  subject: string;
  tone: string;
  body_markdown: string;
  draft_markdown: string;
  draft_path: string;
  json_path: string;
  triage_path: string;
}

export interface EmailDeliveryRequest {
  body_markdown: string;
  draft_mode: boolean;
  approved: boolean;
  message_id?: string;
  reply_mode?: 'new' | 'reply' | 'reply-all';
  subject?: string;
  to?: string;
}

export interface GwsAuthStatus {
  ok: boolean;
  available: boolean;
  auth_method: string | null;
  client_config_exists: boolean;
  credential_source: string | null;
  encrypted_credentials_exists: boolean;
  plain_credentials_exists: boolean;
  storage: string | null;
  token_cache_exists: boolean;
  client_config?: string | null;
  encrypted_credentials?: string | null;
  plain_credentials?: string | null;
  checked_at: string;
  error?: string;
}

export interface GmailMessageHeader {
  name?: string;
  value?: string;
}

export interface GmailMessageListItem {
  id?: string;
  threadId?: string;
}

export interface GmailMessageMetadata {
  id: string;
  threadId?: string;
  labelIds: string[];
  snippet?: string;
  payload?: {
    headers?: GmailMessageHeader[];
  };
}

export interface GmailInboxArchiveCandidate {
  sender_email: string;
  sender_display: string;
  message_ids: string[];
  subject_samples: string[];
  message_count: number;
  existing_filter_id: string | null;
  reason: string;
  will_create_filter: boolean;
  will_archive_messages: boolean;
}

export interface GmailInboxArchiveResult {
  ok: boolean;
  applied: boolean;
  query: string;
  max_messages: number;
  min_count: number;
  inspected_messages: number;
  candidates: GmailInboxArchiveCandidate[];
  created_filters: Array<{
    sender_email: string;
    filter_id: string | null;
    criteria: Record<string, unknown>;
    action: Record<string, unknown>;
  }>;
  archived_message_ids: string[];
}

const GMAIL_INBOX_ARCHIVE_QUERY = 'in:inbox is:unread';
const GMAIL_METADATA_HEADERS = ['From', 'Subject'];
const GMAIL_AUTOMATED_SENDER_RE =
  /(?:no-?reply|noreply|newsletter|digest|notification|notify|alert|update|updates?|mailing)/i;
const GMAIL_INBOX_ARCHIVE_LABEL = 'INBOX';

export function resolveEmailDraftDir(): string {
  return pathResolver.shared('runtime/presence-studio/email-drafts');
}

export function resolveEmailTriagePath(): string {
  return pathResolver.sharedTmp('email-inbox-triage.md');
}

export function resolveLatestEmailDraftPaths(): { markdown: string; json: string } {
  const dir = resolveEmailDraftDir();
  return {
    markdown: path.join(dir, 'latest.md'),
    json: path.join(dir, 'latest.json'),
  };
}

export function extractFirstJsonBlock(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1], trimmed] : [trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (_) {}
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(trimmed.slice(first, last + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (_) {}
  }
  return null;
}

export function extractBodyMarkdownFromDraft(draftMarkdown: string): string {
  const lines = draftMarkdown.split(/\r?\n/);
  const metadataLabels = new Set(['To', 'Subject', 'Tone']);
  let sawMetadata = false;
  let bodyStartIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      if (sawMetadata) {
        bodyStartIndex = index + 1;
        break;
      }
      continue;
    }
    const match = line.match(/^(To|Subject|Tone):\s*(.*)$/);
    if (!match || !metadataLabels.has(match[1])) {
      return draftMarkdown;
    }
    sawMetadata = true;
  }

  if (!sawMetadata) {
    return draftMarkdown;
  }
  if (bodyStartIndex < 0) {
    bodyStartIndex = lines.findIndex((line, index) => index >= 3 && line.trim().length > 0);
    if (bodyStartIndex < 0) {
      return '';
    }
  }
  return lines.slice(bodyStartIndex).join('\n').trim();
}

export function summarizeEmailSubject(triageText: string, fallback = 'Reply'): string {
  const lines = triageText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate =
    lines.find((line) => !/^#+\s/.test(line) && line.length > 8) || lines[0] || fallback;
  return candidate.replace(/^[-*]\s*/, '').slice(0, 90);
}

function normalizeHeaderValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function parseEmailAddressHeader(value: string): { display_name: string; email: string } {
  const trimmed = normalizeHeaderValue(value);
  const angled = trimmed.match(/^(.*)<([^>]+)>$/);
  const emailMatch = trimmed.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

  if (angled) {
    const display_name = normalizeHeaderValue(angled[1].replace(/^"|"$/g, '')) || angled[2].trim();
    const email = angled[2].trim().toLowerCase();
    return { display_name, email };
  }

  if (emailMatch) {
    const email = emailMatch[0].toLowerCase();
    const display_name =
      normalizeHeaderValue(trimmed.replace(emailMatch[0], '').replace(/[<>()"]/g, '')) || email;
    return { display_name, email };
  }

  return {
    display_name: trimmed || 'unknown sender',
    email: trimmed.toLowerCase(),
  };
}

function extractMessageHeader(
  message: GmailMessageMetadata | Record<string, any>,
  headerName: string
): string {
  const headers = Array.isArray(message?.payload?.headers) ? message.payload.headers : [];
  const match = headers.find(
    (header: GmailMessageHeader) =>
      String(header?.name || '').toLowerCase() === headerName.toLowerCase()
  );
  return typeof match?.value === 'string' ? match.value.trim() : '';
}

function extractFilterCriteriaFromSender(senderEmail: string): Record<string, unknown> {
  return {
    from: senderEmail,
  };
}

function extractFilterAction(): Record<string, unknown> {
  return {
    removeLabelIds: [GMAIL_INBOX_ARCHIVE_LABEL],
  };
}

function extractMessageList(payload: any): GmailMessageListItem[] {
  if (Array.isArray(payload)) {
    return payload.filter((item) => item && typeof item === 'object') as GmailMessageListItem[];
  }
  return Array.isArray(payload?.messages) ? payload.messages : [];
}

function extractFilterList(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.filter) ? payload.filter : [];
}

function isAutomatedSender(senderEmail: string, senderDisplay: string): boolean {
  return (
    GMAIL_AUTOMATED_SENDER_RE.test(senderEmail) || GMAIL_AUTOMATED_SENDER_RE.test(senderDisplay)
  );
}

function normalizeSenderKey(senderEmail: string): string {
  return senderEmail.trim().toLowerCase();
}

function matchExistingArchiveFilter(filters: any[], senderEmail: string): string | null {
  const normalizedSender = normalizeSenderKey(senderEmail);
  for (const filter of filters) {
    const criteria = filter?.criteria || {};
    const action = filter?.action || {};
    const removeLabelIds = Array.isArray(action?.removeLabelIds)
      ? action.removeLabelIds.map((label: unknown) => String(label))
      : [];
    if (!removeLabelIds.includes(GMAIL_INBOX_ARCHIVE_LABEL)) {
      continue;
    }

    const fromCriteria =
      typeof criteria?.from === 'string'
        ? normalizeSenderKey(parseEmailAddressHeader(criteria.from).email)
        : '';
    if (fromCriteria && fromCriteria === normalizedSender) {
      return typeof filter?.id === 'string' ? filter.id : null;
    }

    const query = typeof criteria?.query === 'string' ? criteria.query.toLowerCase() : '';
    if (
      query.includes(`from:${normalizedSender}`) ||
      query.includes(`from:"${normalizedSender}"`)
    ) {
      return typeof filter?.id === 'string' ? filter.id : null;
    }
  }
  return null;
}

async function gwsJson(
  action: string,
  params: Record<string, unknown>,
  body?: Record<string, unknown>
): Promise<any> {
  const request: Record<string, unknown> = { params };
  if (body !== undefined) {
    request.body = body;
  }
  return await executeServicePreset('google-workspace', action, request);
}

async function listUnreadInboxMessages(limit: number): Promise<GmailMessageListItem[]> {
  const collected: GmailMessageListItem[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gwsJson('gmail_messages_list', {
      userId: 'me',
      q: GMAIL_INBOX_ARCHIVE_QUERY,
      maxResults: Math.max(1, Math.min(limit, 500)),
      ...(pageToken ? { pageToken } : {}),
    });
    const pageMessages = extractMessageList(page);
    for (const item of pageMessages) {
      if (item?.id) {
        collected.push({ id: item.id, threadId: item.threadId });
      }
      if (collected.length >= limit) {
        return collected;
      }
    }
    pageToken =
      typeof page?.nextPageToken === 'string' && page.nextPageToken.trim()
        ? page.nextPageToken
        : undefined;
  } while (pageToken);
  return collected;
}

async function getInboxMessageMetadata(messageId: string): Promise<GmailMessageMetadata | null> {
  if (!messageId) return null;
  const message = await gwsJson('gmail_message_get', {
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: GMAIL_METADATA_HEADERS,
  });
  if (!message || typeof message !== 'object') {
    return null;
  }
  return {
    id: String(message.id || messageId),
    threadId: typeof message.threadId === 'string' ? message.threadId : undefined,
    labelIds: Array.isArray(message.labelIds)
      ? message.labelIds.map((label: unknown) => String(label))
      : [],
    snippet: typeof message.snippet === 'string' ? message.snippet : undefined,
    payload:
      message.payload && typeof message.payload === 'object'
        ? {
            headers: Array.isArray(message.payload.headers)
              ? message.payload.headers
                  .map((header: GmailMessageHeader) => ({
                    name: typeof header?.name === 'string' ? header.name : undefined,
                    value: typeof header?.value === 'string' ? header.value : undefined,
                  }))
                  .filter((header: GmailMessageHeader) => Boolean(header.name || header.value))
              : [],
          }
        : undefined,
  };
}

async function listGmailFilters(): Promise<any[]> {
  const response = await gwsJson('gmail_filters_list', { userId: 'me' });
  return extractFilterList(response);
}

async function createArchiveFilter(senderEmail: string): Promise<any> {
  return await gwsJson(
    'gmail_filters_create',
    { userId: 'me' },
    {
      criteria: extractFilterCriteriaFromSender(senderEmail),
      action: extractFilterAction(),
    }
  );
}

async function batchArchiveMessageIds(messageIds: string[]): Promise<any> {
  if (messageIds.length === 0) {
    return { ok: true, archived_message_ids: [] };
  }
  return await gwsJson(
    'gmail_messages_batch_modify',
    { userId: 'me' },
    {
      ids: messageIds,
      removeLabelIds: [GMAIL_INBOX_ARCHIVE_LABEL],
    }
  );
}

export interface GmailInboxArchiveInput {
  max_messages?: number;
  min_count?: number;
  apply?: boolean;
}

export async function organizeGmailInboxWithFilters(
  input: GmailInboxArchiveInput = {}
): Promise<GmailInboxArchiveResult> {
  const resolvedMaxMessages = Number(input.max_messages);
  const resolvedMinCount = Number(input.min_count);
  const maxMessages = Math.max(
    1,
    Math.min(Number.isFinite(resolvedMaxMessages) ? resolvedMaxMessages : 50, 500)
  );
  const minCount = Math.max(1, Number.isFinite(resolvedMinCount) ? resolvedMinCount : 2);
  const apply = input.apply === true;

  const messageList = await listUnreadInboxMessages(maxMessages);
  const messageDetails = [];
  for (const item of messageList) {
    if (!item.id) continue;
    const detail = await getInboxMessageMetadata(item.id);
    if (detail) {
      messageDetails.push(detail);
    }
  }

  const filters = await listGmailFilters();
  const grouped = new Map<
    string,
    {
      sender_email: string;
      sender_display: string;
      message_ids: string[];
      subject_samples: string[];
    }
  >();

  for (const message of messageDetails) {
    const headerValue = extractMessageHeader(message, 'From');
    if (!headerValue) continue;
    const sender = parseEmailAddressHeader(headerValue);
    const senderKey = normalizeSenderKey(sender.email);
    if (!senderKey) continue;
    const existing = grouped.get(senderKey) || {
      sender_email: sender.email,
      sender_display: sender.display_name,
      message_ids: [],
      subject_samples: [],
    };
    existing.message_ids.push(message.id);
    const subject = extractMessageHeader(message, 'Subject');
    if (subject && !existing.subject_samples.includes(subject)) {
      existing.subject_samples.push(subject);
    }
    if (!existing.sender_display && sender.display_name) {
      existing.sender_display = sender.display_name;
    }
    grouped.set(senderKey, existing);
  }

  const candidates: GmailInboxArchiveCandidate[] = [];
  const createdFilters: Array<{
    sender_email: string;
    filter_id: string | null;
    criteria: Record<string, unknown>;
    action: Record<string, unknown>;
  }> = [];
  const archivedMessageIds = new Set<string>();

  for (const group of grouped.values()) {
    const isAutomated = isAutomatedSender(group.sender_email, group.sender_display);
    const qualifies = group.message_ids.length >= minCount || isAutomated;
    const existingFilterId = matchExistingArchiveFilter(filters, group.sender_email);
    const willCreateFilter = !existingFilterId && qualifies;
    const willArchiveMessages = qualifies || Boolean(existingFilterId);

    const reason = existingFilterId
      ? `existing archive filter ${existingFilterId}`
      : isAutomated
        ? 'automated sender pattern'
        : group.message_ids.length >= minCount
          ? `repeated sender (${group.message_ids.length} messages)`
          : 'sender did not meet archive threshold';

    candidates.push({
      sender_email: group.sender_email,
      sender_display: group.sender_display,
      message_ids: [...group.message_ids],
      subject_samples: [...group.subject_samples],
      message_count: group.message_ids.length,
      existing_filter_id: existingFilterId,
      reason,
      will_create_filter: willCreateFilter,
      will_archive_messages: willArchiveMessages,
    });

    if (apply && willCreateFilter) {
      const filter = await createArchiveFilter(group.sender_email);
      createdFilters.push({
        sender_email: group.sender_email,
        filter_id: typeof filter?.id === 'string' ? filter.id : null,
        criteria: extractFilterCriteriaFromSender(group.sender_email),
        action: extractFilterAction(),
      });
    }

    if (willArchiveMessages) {
      for (const messageId of group.message_ids) {
        archivedMessageIds.add(messageId);
      }
    }
  }

  if (apply && archivedMessageIds.size > 0) {
    await batchArchiveMessageIds([...archivedMessageIds]);
  }

  return {
    ok: true,
    applied: apply,
    query: GMAIL_INBOX_ARCHIVE_QUERY,
    max_messages: maxMessages,
    min_count: minCount,
    inspected_messages: messageDetails.length,
    candidates,
    created_filters: createdFilters,
    archived_message_ids: [...archivedMessageIds],
  };
}

export function buildFallbackEmailDraft(input: {
  to: string;
  subject: string;
  tone: string;
  triageText: string;
}): { body_markdown: string; draft_markdown: string } {
  const triagePreview = input.triageText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join('\n');
  const body = [
    `Hi${input.to ? ` ${input.to}` : ''},`,
    '',
    `Thanks for the update. I reviewed the inbox triage in a ${input.tone} tone.`,
    '',
    'Current understanding:',
    triagePreview
      ? triagePreview
          .split('\n')
          .map((line) => `- ${line}`)
          .join('\n')
      : '- No triage details available yet.',
    '',
    'Suggested next step:',
    '- ',
    '',
    'Best,',
    'Kyberion',
  ].join('\n');
  const draft = [
    `To: ${input.to || 'TBD'}`,
    `Subject: ${input.subject}`,
    `Tone: ${input.tone}`,
    '',
    body,
    '',
  ].join('\n');
  return { body_markdown: body, draft_markdown: draft };
}

export function readEmailDraftArtifact(): EmailDraftArtifact {
  const { markdown, json } = resolveLatestEmailDraftPaths();
  if (safeExistsSync(json)) {
    try {
      const parsed = JSON.parse(String(safeReadFile(json, { encoding: 'utf8' }) || ''));
      if (parsed && typeof parsed === 'object') {
        const jsonStat = safeStat(json);
        return {
          exists: true,
          path: typeof parsed.path === 'string' ? parsed.path : markdown,
          json_path: json,
          updated_at:
            typeof parsed.updated_at === 'string'
              ? parsed.updated_at
              : jsonStat?.mtime instanceof Date
                ? jsonStat.mtime.toISOString()
                : null,
          to: typeof parsed.to === 'string' ? parsed.to : '',
          subject: typeof parsed.subject === 'string' ? parsed.subject : '',
          tone: typeof parsed.tone === 'string' ? parsed.tone : 'clear and concise',
          body_markdown: typeof parsed.body_markdown === 'string' ? parsed.body_markdown : '',
          draft_markdown: typeof parsed.draft_markdown === 'string' ? parsed.draft_markdown : '',
          triage_path:
            typeof parsed.triage_path === 'string' ? parsed.triage_path : resolveEmailTriagePath(),
        };
      }
    } catch (_) {}
  }
  if (safeExistsSync(markdown)) {
    const draftMarkdown = String(safeReadFile(markdown, { encoding: 'utf8' }) || '');
    const markdownStat = safeStat(markdown);
    return {
      exists: true,
      path: markdown,
      json_path: json,
      updated_at: markdownStat?.mtime instanceof Date ? markdownStat.mtime.toISOString() : null,
      to: '',
      subject: '',
      tone: 'clear and concise',
      body_markdown: extractBodyMarkdownFromDraft(draftMarkdown),
      draft_markdown: draftMarkdown,
      triage_path: resolveEmailTriagePath(),
    };
  }
  return {
    exists: false,
    path: markdown,
    json_path: json,
    updated_at: null,
    to: '',
    subject: '',
    tone: 'clear and concise',
    body_markdown: '',
    draft_markdown: '',
    triage_path: resolveEmailTriagePath(),
  };
}

export function readGwsAuthStatus(): GwsAuthStatus {
  const checkedAt = new Date().toISOString();
  try {
    const raw = safeExec('gws', ['auth', 'status'], { timeoutMs: 5_000, maxOutputMB: 1 }).trim();
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      ok: true,
      available: true,
      auth_method: typeof parsed.auth_method === 'string' ? parsed.auth_method : null,
      client_config_exists: Boolean(parsed.client_config_exists),
      credential_source:
        typeof parsed.credential_source === 'string' ? parsed.credential_source : null,
      encrypted_credentials_exists: Boolean(parsed.encrypted_credentials_exists),
      plain_credentials_exists: Boolean(parsed.plain_credentials_exists),
      storage: typeof parsed.storage === 'string' ? parsed.storage : null,
      token_cache_exists: Boolean(parsed.token_cache_exists),
      client_config: typeof parsed.client_config === 'string' ? parsed.client_config : null,
      encrypted_credentials:
        typeof parsed.encrypted_credentials === 'string' ? parsed.encrypted_credentials : null,
      plain_credentials:
        typeof parsed.plain_credentials === 'string' ? parsed.plain_credentials : null,
      checked_at: checkedAt,
    };
  } catch (error: any) {
    return {
      ok: false,
      available: false,
      auth_method: null,
      client_config_exists: false,
      credential_source: null,
      encrypted_credentials_exists: false,
      plain_credentials_exists: false,
      storage: null,
      token_cache_exists: false,
      checked_at: checkedAt,
      error: error?.message || String(error),
    };
  }
}

function writeDraftModeFallbackArtifact(request: EmailDeliveryRequest) {
  const timestamp = new Date().toISOString();
  const draftDir = resolveEmailDraftDir();
  safeMkdir(draftDir, { recursive: true });
  const fallbackId = `gws-fallback-${randomUUID()}`;
  const artifactDir = path.join(draftDir, fallbackId);
  safeMkdir(artifactDir, { recursive: true });

  const subject = request.subject?.trim() || 'Re: Inbox update';
  const to = request.to?.trim() || '';
  const draftPath = path.join(artifactDir, `email-draft-${fallbackId}.md`);
  const jsonPath = path.join(artifactDir, `email-draft-${fallbackId}.json`);
  const draftMarkdown = [
    `To: ${to || 'TBD'}`,
    `Subject: ${subject}`,
    `Tone: clear and concise`,
    '',
    request.body_markdown.trim(),
    '',
  ].join('\n');

  safeWriteFile(draftPath, draftMarkdown, { encoding: 'utf8' });
  safeWriteFile(
    jsonPath,
    JSON.stringify(
      {
        request_id: fallbackId,
        backend: 'local-fallback',
        fallback_reason: 'gws delivery unavailable',
        to,
        subject,
        body_markdown: request.body_markdown.trim(),
        draft_markdown: draftMarkdown,
        draft_path: draftPath,
        updated_at: timestamp,
      },
      null,
      2
    ),
    { encoding: 'utf8' }
  );

  const latest = resolveLatestEmailDraftPaths();
  safeWriteFile(latest.markdown, `${draftMarkdown}\n`, { encoding: 'utf8' });
  safeWriteFile(
    latest.json,
    JSON.stringify(
      {
        exists: true,
        path: draftPath,
        json_path: jsonPath,
        updated_at: timestamp,
        to,
        subject,
        tone: 'clear and concise',
        body_markdown: request.body_markdown.trim(),
        draft_markdown: draftMarkdown,
        fallback_reason: 'gws delivery unavailable',
      },
      null,
      2
    ),
    { encoding: 'utf8' }
  );

  return {
    ok: true,
    fallback: true,
    backend: 'local-fallback',
    reason: 'gws delivery unavailable',
    request_id: fallbackId,
    to,
    subject,
    body_markdown: request.body_markdown.trim(),
    draft_markdown: draftMarkdown,
    draft_path: draftPath,
    json_path: jsonPath,
  };
}

export async function generateEmailReplyDraft(
  input: EmailDraftGenerationInput
): Promise<EmailDraftGenerationResult> {
  const requestId = input.requestId?.trim() || randomUUID();
  const recipient = input.recipient?.trim() || '';
  const subjectInput = input.subjectInput?.trim() || '';
  const tone = input.tone?.trim() || 'clear and concise';
  const rawTriageText = input.triageText.trim();
  if (!rawTriageText) {
    throw new Error('triage_text is required when no email triage file exists');
  }
  const processed = processUntrustedContent(rawTriageText, 'email-triage');
  const triageText = processed.wrapped;

  const draftDir = resolveEmailDraftDir();
  safeMkdir(draftDir, { recursive: true });
  const artifactDir = path.join(draftDir, requestId);
  safeMkdir(artifactDir, { recursive: true });

  const triagePath = path.join(artifactDir, `triage-${requestId}.md`);
  safeWriteFile(triagePath, `${triageText}\n`, { encoding: 'utf8' });

  const defaultSubject = subjectInput || `Re: ${summarizeEmailSubject(triageText, 'Inbox update')}`;
  const backend = getReasoningBackend();
  const delegateTask = input.delegateTask || backend.delegateTask.bind(backend);
  const backendName = input.backendName || (backend as any)?.name || 'unknown';
  let body_markdown = '';
  let draft_markdown = '';
  let generatedTo = recipient;
  let generatedSubject = defaultSubject;
  let backendLabel = backendName;

  try {
    const prompt = [
      'You are drafting a concise email reply from inbox triage.',
      'Output ONLY a JSON object with keys: to, subject, body_markdown, draft_markdown.',
      'Do not invent commitments. Keep it actionable and safe.',
      `Tone: ${tone}`,
      recipient ? `Recipient: ${recipient}` : 'Recipient: not provided',
      `Subject: ${defaultSubject}`,
      'Triage notes:',
      triageText,
    ].join('\n');
    const raw = await delegateTask(prompt, `email-draft:${requestId}`);
    const parsed = extractFirstJsonBlock(raw);
    if (parsed) {
      generatedTo =
        typeof parsed.to === 'string' && parsed.to.trim() ? parsed.to.trim() : generatedTo;
      generatedSubject =
        typeof parsed.subject === 'string' && parsed.subject.trim()
          ? parsed.subject.trim()
          : generatedSubject;
      body_markdown = typeof parsed.body_markdown === 'string' ? parsed.body_markdown.trim() : '';
      draft_markdown =
        typeof parsed.draft_markdown === 'string' ? parsed.draft_markdown.trim() : '';
    }
  } catch (_) {
    // fall through to fallback draft
  }

  if (!body_markdown || !draft_markdown) {
    const fallback = buildFallbackEmailDraft({
      to: generatedTo,
      subject: generatedSubject,
      tone,
      triageText,
    });
    body_markdown = fallback.body_markdown;
    draft_markdown = fallback.draft_markdown;
  }

  const draftPath = path.join(artifactDir, `email-draft-${requestId}.md`);
  const jsonPath = path.join(artifactDir, `email-draft-${requestId}.json`);
  safeWriteFile(draftPath, draft_markdown, { encoding: 'utf8' });
  safeWriteFile(
    jsonPath,
    JSON.stringify(
      {
        request_id: requestId,
        backend: backendLabel,
        to: generatedTo,
        subject: generatedSubject,
        tone,
        body_markdown,
        draft_markdown,
        triage_path: triagePath,
        draft_path: draftPath,
        updated_at: new Date().toISOString(),
      },
      null,
      2
    ),
    { encoding: 'utf8' }
  );

  const latest = resolveLatestEmailDraftPaths();
  safeWriteFile(latest.markdown, `${draft_markdown}\n`, { encoding: 'utf8' });
  safeWriteFile(
    latest.json,
    JSON.stringify(
      {
        exists: true,
        path: draftPath,
        json_path: jsonPath,
        updated_at: new Date().toISOString(),
        to: generatedTo,
        subject: generatedSubject,
        tone,
        body_markdown,
        draft_markdown,
        triage_path: triagePath,
      },
      null,
      2
    ),
    { encoding: 'utf8' }
  );

  return {
    request_id: requestId,
    backend: backendLabel,
    to: generatedTo,
    subject: generatedSubject,
    tone,
    body_markdown,
    draft_markdown,
    draft_path: draftPath,
    json_path: jsonPath,
    triage_path: triagePath,
  };
}

export async function executeGmailDelivery(request: EmailDeliveryRequest) {
  const replyMode = request.reply_mode || 'new';
  const draftMode = request.draft_mode === true;
  const body = request.body_markdown.trim();
  if (!body) {
    throw new Error('body_markdown is required');
  }

  if (replyMode === 'reply' || replyMode === 'reply-all') {
    const messageId = request.message_id?.trim();
    if (!messageId) {
      throw new Error('message_id is required for reply mode');
    }
    const action =
      replyMode === 'reply-all'
        ? draftMode
          ? 'gmail_reply_all_draft'
          : 'gmail_reply_all'
        : draftMode
          ? 'gmail_reply_draft'
          : 'gmail_reply';
    try {
      return await executeServicePreset('google-workspace', action, {
        message_id: messageId,
        body,
      });
    } catch (error: any) {
      if (draftMode) {
        return writeDraftModeFallbackArtifact(request);
      }
      throw error;
    }
  }

  const action = draftMode ? 'gmail_send_draft' : 'gmail_send';
  try {
    return await executeServicePreset('google-workspace', action, {
      to: request.to?.trim() || '',
      subject: request.subject?.trim() || 'Re: Inbox update',
      body,
    });
  } catch (error: any) {
    if (draftMode) {
      return writeDraftModeFallbackArtifact(request);
    }
    throw error;
  }
}
