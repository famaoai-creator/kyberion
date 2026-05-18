import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getReasoningBackend } from './reasoning-backend.js';
import { executeServicePreset } from './service-engine.js';
import { pathResolver } from './path-resolver.js';
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
  const lines = triageText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const candidate = lines.find((line) => !/^#+\s/.test(line) && line.length > 8) || lines[0] || fallback;
  return candidate.replace(/^[-*]\s*/, '').slice(0, 90);
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
    triagePreview ? triagePreview.split('\n').map((line) => `- ${line}`).join('\n') : '- No triage details available yet.',
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
          updated_at: typeof parsed.updated_at === 'string'
            ? parsed.updated_at
            : jsonStat?.mtime instanceof Date
              ? jsonStat.mtime.toISOString()
              : null,
          to: typeof parsed.to === 'string' ? parsed.to : '',
          subject: typeof parsed.subject === 'string' ? parsed.subject : '',
          tone: typeof parsed.tone === 'string' ? parsed.tone : 'clear and concise',
          body_markdown: typeof parsed.body_markdown === 'string' ? parsed.body_markdown : '',
          draft_markdown: typeof parsed.draft_markdown === 'string' ? parsed.draft_markdown : '',
          triage_path: typeof parsed.triage_path === 'string' ? parsed.triage_path : resolveEmailTriagePath(),
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
      credential_source: typeof parsed.credential_source === 'string' ? parsed.credential_source : null,
      encrypted_credentials_exists: Boolean(parsed.encrypted_credentials_exists),
      plain_credentials_exists: Boolean(parsed.plain_credentials_exists),
      storage: typeof parsed.storage === 'string' ? parsed.storage : null,
      token_cache_exists: Boolean(parsed.token_cache_exists),
      client_config: typeof parsed.client_config === 'string' ? parsed.client_config : null,
      encrypted_credentials: typeof parsed.encrypted_credentials === 'string' ? parsed.encrypted_credentials : null,
      plain_credentials: typeof parsed.plain_credentials === 'string' ? parsed.plain_credentials : null,
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

export async function generateEmailReplyDraft(input: EmailDraftGenerationInput): Promise<EmailDraftGenerationResult> {
  const requestId = input.requestId?.trim() || randomUUID();
  const recipient = input.recipient?.trim() || '';
  const subjectInput = input.subjectInput?.trim() || '';
  const tone = input.tone?.trim() || 'clear and concise';
  const triageText = input.triageText.trim();
  if (!triageText) {
    throw new Error('triage_text is required when no email triage file exists');
  }

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
      generatedTo = typeof parsed.to === 'string' && parsed.to.trim() ? parsed.to.trim() : generatedTo;
      generatedSubject = typeof parsed.subject === 'string' && parsed.subject.trim() ? parsed.subject.trim() : generatedSubject;
      body_markdown = typeof parsed.body_markdown === 'string' ? parsed.body_markdown.trim() : '';
      draft_markdown = typeof parsed.draft_markdown === 'string' ? parsed.draft_markdown.trim() : '';
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
      2,
    ),
    { encoding: 'utf8' },
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
      2,
    ),
    { encoding: 'utf8' },
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
    const action = replyMode === 'reply-all'
      ? (draftMode ? 'gmail_reply_all_draft' : 'gmail_reply_all')
      : (draftMode ? 'gmail_reply_draft' : 'gmail_reply');
    return await executeServicePreset('google-workspace', action, {
      message_id: messageId,
      body,
    });
  }

  const action = draftMode ? 'gmail_send_draft' : 'gmail_send';
  return await executeServicePreset('google-workspace', action, {
    to: request.to?.trim() || '',
    subject: request.subject?.trim() || 'Re: Inbox update',
    body,
  });
}
