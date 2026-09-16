/** Import legacy pad handoffs into the durable unified-pad index. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertSafeRepositoryPath, pathResolver, toRepoRelative } from '@agent/core/path-resolver';
import { readJson, nowIso } from '@agent/core/foundation';
import { safeExistsSync, safeReadFile, safeReaddir, safeStat } from '@agent/core/secure-io';
import { defineScript, isDirectScript } from '../lib/harness.js';
import { PAD_IDS, isPadId, type PadId } from './registry.js';
import { PadRecordStore, type PadArtifactInput } from './storage.js';

// Increment when canonical migration semantics change.  The revision is part
// of the idempotency identity so a re-run can repair records produced by an
// older migrator instead of silently keeping an incomplete payload.
const LEGACY_MIGRATION_SCHEMA = '2';

export interface MigrationItem {
  pad_id: PadId;
  source: string;
  status: 'ready' | 'held' | 'migrated' | 'skipped';
  reason?: string;
  content_sha256?: string;
  record_id?: string;
}

export interface MigrationReport {
  ok: boolean;
  mode: 'dry-run' | 'apply';
  scanned: number;
  migrated: number;
  held: number;
  items: MigrationItem[];
}

function legacyRoots(): string[] {
  return PAD_IDS.map((pad) => pathResolver.sharedTmp(pad));
}

function handoffs(root: string): string[] {
  if (!safeExistsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const name of safeReaddir(dir)) {
      const candidate = path.join(dir, name);
      if (safeStat(candidate).isDirectory()) walk(candidate, depth + 1);
      else if (name === 'handoff.json') found.push(candidate);
    }
  };
  walk(root, 0);
  return found;
}

function readLegacyText(ref: unknown): string | undefined {
  if (typeof ref !== 'string' || !ref.trim()) return undefined;
  const resolved = ref.startsWith('/') ? ref : pathResolver.rootResolve(ref);
  const tmpRoot = path.resolve(pathResolver.sharedTmp(''));
  const relative = path.relative(tmpRoot, path.resolve(resolved));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return undefined;
  try {
    assertSafeRepositoryPath(resolved);
  } catch {
    return undefined;
  }
  if (!safeExistsSync(resolved)) return undefined;
  return String(safeReadFile(resolved, { encoding: 'utf8' }));
}

function readClipboardText(handoff: Record<string, unknown>): string | undefined {
  const raw = readLegacyText(handoff.items_path);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return raw;
    return parsed.items
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const row = item as Record<string, unknown>;
        const text = typeof row.text === 'string' ? row.text : '';
        const label = typeof row.label === 'string' ? row.label : '';
        return label ? `${label}: ${text}` : text;
      })
      .filter(Boolean)
      .join('\n');
  } catch {
    return raw;
  }
}

interface MeetingMinutesScan {
  fields: {
    summary: string;
    decisions: string;
    action_items: string;
    open_questions: string;
  };
  omitted: string[];
}

function markdownSection(markdown: string, heading: string): string {
  const match = new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'mu').exec(
    markdown
  );
  return match?.[1]?.trim().replace(/^- /gmu, '').trim() ?? '';
}

function readMeetingMinutes(handoff: Record<string, unknown>): MeetingMinutesScan {
  const omitted: string[] = [];
  const jsonRef = handoff.minutes_json_path;
  const markdownRef = handoff.minutes_path;
  if (jsonRef !== undefined && jsonRef !== null) {
    const raw = readLegacyText(jsonRef);
    if (raw === undefined) omitted.push('minutes_json_path: ファイルが見つかりません');
    else {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const list = (key: string): string => {
          const value = parsed[key];
          return Array.isArray(value)
            ? value.map(String).join('\n')
            : typeof value === 'string'
              ? value
              : '';
        };
        return {
          fields: {
            summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
            decisions: list('decisions'),
            action_items: list('action_items'),
            open_questions: list('open_questions'),
          },
          omitted,
        };
      } catch {
        omitted.push('minutes_json_path: JSON が不正です');
      }
    }
  }
  if (markdownRef !== undefined && markdownRef !== null) {
    const markdown = readLegacyText(markdownRef);
    if (markdown === undefined) omitted.push('minutes_path: ファイルが見つかりません');
    else {
      return {
        fields: {
          summary: markdownSection(markdown, 'Summary'),
          decisions: markdownSection(markdown, 'Decisions'),
          action_items: markdownSection(markdown, 'Action Items'),
          open_questions: markdownSection(markdown, 'Open Questions'),
        },
        omitted,
      };
    }
  }
  return { fields: { summary: '', decisions: '', action_items: '', open_questions: '' }, omitted };
}

/** Reconstruct searchable record text from each historical handoff shape. */
function readBody(padId: PadId, handoff: Record<string, unknown>): string | undefined {
  const generic = readLegacyText(handoff.notes_path) ?? readLegacyText(handoff.content_path);
  if (generic !== undefined) {
    if (padId !== 'meeting-notepad') return generic;
    const transcript = readLegacyText(handoff.transcript_path);
    return [generic, transcript]
      .filter((value): value is string => value !== undefined)
      .join('\n\n');
  }
  switch (padId) {
    case 'daily-desk': {
      const sections: Array<[string, string]> = [];
      for (const [label, ref] of [
        ['Journal', handoff.journal_path],
        ['TODO', handoff.todo_path],
        ['NOW', handoff.now_path],
      ] as const) {
        const value = readLegacyText(ref);
        if (value !== undefined) sections.push([label, value]);
      }
      return sections.length
        ? sections.map(([label, value]) => `${label}\n${value}`).join('\n\n')
        : undefined;
    }
    case 'clipboard-inbox': {
      return readClipboardText(handoff);
    }
    case 'personal-workbench': {
      const entry = handoff.entry;
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).body === 'string'
      ) {
        return String((entry as Record<string, unknown>).body);
      }
      return undefined;
    }
    case 'sketch-input':
    case 'screenshot-annotate': {
      const instruction = typeof handoff.instruction === 'string' ? handoff.instruction.trim() : '';
      const hasImage = typeof handoff.image_path === 'string' && Boolean(handoff.image_path.trim());
      return instruction || (hasImage ? '（画像 artifact）' : undefined);
    }
    case 'doc-drop': {
      const names = Array.isArray(handoff.attachments)
        ? handoff.attachments
            .map((item) =>
              item &&
              typeof item === 'object' &&
              typeof (item as Record<string, unknown>).name === 'string'
                ? String((item as Record<string, unknown>).name)
                : ''
            )
            .filter(Boolean)
        : [];
      const instruction = typeof handoff.instruction === 'string' ? handoff.instruction.trim() : '';
      if (!names.length && !instruction) return undefined;
      return `${names.length ? `添付: ${names.join(', ')}` : ''}${instruction ? `\n確認メモ: ${instruction}` : ''}`.trim();
    }
    default:
      return undefined;
  }
}

interface LegacyArtifactsResult {
  artifacts: PadArtifactInput[];
  omitted: string[];
}

function readLegacyArtifacts(
  padId: PadId,
  handoff: Record<string, unknown>
): LegacyArtifactsResult {
  const candidates: Array<{ field_id: string; name: string; mime: string; path: string }> = [];
  const attachments = Array.isArray(handoff.attachments) ? handoff.attachments : [];
  for (const [index, value] of attachments.entries()) {
    if (!value || typeof value !== 'object') {
      candidates.push({
        field_id: padId === 'meeting-notepad' ? 'attachment_name' : 'file_name',
        name: `attachment-${index + 1}`,
        mime: 'application/octet-stream',
        path: '',
      });
      continue;
    }
    const row = value as Record<string, unknown>;
    if (typeof row.path !== 'string' || !row.path.trim()) {
      candidates.push({
        field_id: padId === 'meeting-notepad' ? 'attachment_name' : 'file_name',
        name: typeof row.name === 'string' ? row.name : `attachment-${index + 1}`,
        mime: typeof row.mime === 'string' ? row.mime : 'application/octet-stream',
        path: '',
      });
      continue;
    }
    candidates.push({
      field_id: padId === 'meeting-notepad' ? 'attachment_name' : 'file_name',
      name: typeof row.name === 'string' ? row.name : `attachment-${index + 1}`,
      mime: typeof row.mime === 'string' ? row.mime : 'application/octet-stream',
      path: row.path,
    });
  }
  const hasSessionImageRef = Object.prototype.hasOwnProperty.call(handoff, 'session_image_path');
  const imagePath =
    padId === 'screenshot-annotate' && hasSessionImageRef
      ? typeof handoff.session_image_path === 'string'
        ? handoff.session_image_path
        : ''
      : handoff.image_path;
  if (typeof imagePath === 'string') {
    candidates.push({
      field_id: padId === 'sketch-input' ? 'drawing_data' : 'image_name',
      name: typeof handoff.image_name === 'string' ? handoff.image_name : 'image.png',
      mime: typeof handoff.image_mime === 'string' ? handoff.image_mime : 'image/png',
      path: imagePath,
    });
  }
  const tmpRoot = path.resolve(pathResolver.sharedTmp(''));
  const artifacts: PadArtifactInput[] = [];
  const omitted: string[] = [];
  if (candidates.length > 16)
    omitted.push(`添付が16件を超えています（${candidates.length - 16}件）`);
  for (const [index, candidate] of candidates.slice(0, 16).entries()) {
    const label = candidate.name || `添付${index + 1}`;
    if (!candidate.path) {
      omitted.push(`${label}: パスがありません`);
      continue;
    }
    const resolved = candidate.path.startsWith('/')
      ? path.resolve(candidate.path)
      : pathResolver.rootResolve(candidate.path);
    const relative = path.relative(tmpRoot, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      omitted.push(`${label}: 管理対象外のパス`);
      continue;
    }
    try {
      assertSafeRepositoryPath(resolved);
      if (!safeExistsSync(resolved)) {
        omitted.push(`${label}: ファイルが見つかりません`);
        continue;
      }
      const bytes = safeReadFile(resolved, { encoding: null });
      if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1) {
        omitted.push(`${label}: 空または不正なファイル`);
        continue;
      }
      if (bytes.byteLength > 12 * 1024 * 1024) {
        omitted.push(`${label}: 12 MiB を超えています`);
        continue;
      }
      artifacts.push({
        field_id: candidate.field_id,
        name: candidate.name,
        mime: candidate.mime,
        data_base64: bytes.toString('base64'),
      });
    } catch {
      // A missing or unsafe legacy attachment is held; migration never guesses
      // a replacement path or publishes a partial record as successful.
      omitted.push(`${label}: 読み込みに失敗しました`);
    }
  }
  return { artifacts, omitted };
}

function handoffText(handoff: Record<string, unknown>, key: string): string {
  return typeof handoff[key] === 'string' ? String(handoff[key]).trim() : '';
}

/** Canonical, non-binary adapter state used when a legacy record is reopened. */
function canonicalPayload(
  padId: PadId,
  handoff: Record<string, unknown>,
  body: string,
  artifacts: readonly PadArtifactInput[],
  minutes: MeetingMinutesScan
): Record<string, string> {
  const names = (fieldId: string): string =>
    artifacts
      .filter((artifact) => artifact.field_id === fieldId)
      .map((artifact) => artifact.name)
      .join('\n');
  switch (padId) {
    case 'memory-capture':
      return {
        body,
        tags: handoffText(handoff, 'tags'),
        target: ['now', 'todo'].includes(handoffText(handoff, 'target'))
          ? handoffText(handoff, 'target')
          : 'note',
        instruction: handoffText(handoff, 'instruction'),
      };
    case 'meeting-notepad':
      return {
        attendees: Array.isArray(handoff.attendees)
          ? handoff.attendees.map(String).join(', ')
          : handoffText(handoff, 'attendees'),
        language: handoffText(handoff, 'language'),
        instruction: handoffText(handoff, 'instruction'),
        notes: readLegacyText(handoff.notes_path) ?? '',
        transcript: readLegacyText(handoff.transcript_path) ?? '',
        summary: minutes.fields.summary,
        decisions: minutes.fields.decisions,
        handoff: minutes.fields.action_items,
        action_items: minutes.fields.action_items,
        open_questions: minutes.fields.open_questions,
        attachment_name: names('attachment_name'),
      };
    case 'sketch-input':
      return {
        instruction: handoffText(handoff, 'instruction'),
        drawing_data: names('drawing_data'),
      };
    case 'clipboard-inbox': {
      const items = readClipboardText(handoff) ?? '';
      return {
        body: items,
        items,
        source: handoffText(handoff, 'source'),
        url: handoffText(handoff, 'url'),
        instruction: handoffText(handoff, 'instruction'),
        target: handoffText(handoff, 'target'),
      };
    }
    case 'daily-desk':
      return {
        journal: readLegacyText(handoff.journal_path) ?? '',
        todo: readLegacyText(handoff.todo_path) ?? '',
        now: readLegacyText(handoff.now_path) ?? '',
        period_key: handoffText(handoff, 'period_key'),
        instruction: handoffText(handoff, 'instruction'),
      };
    case 'doc-drop':
      return { file_name: names('file_name'), review_note: handoffText(handoff, 'instruction') };
    case 'screenshot-annotate':
      return {
        image_name: names('image_name'),
        annotation: handoffText(handoff, 'instruction'),
      };
    case 'personal-workbench': {
      const entry =
        handoff.entry && typeof handoff.entry === 'object'
          ? (handoff.entry as Record<string, unknown>)
          : {};
      const metadata =
        entry.metadata && typeof entry.metadata === 'object'
          ? (entry.metadata as Record<string, unknown>)
          : {};
      return {
        entry_type: typeof entry.kind === 'string' ? entry.kind : '',
        due: typeof metadata.due === 'string' ? metadata.due : '',
        body: typeof entry.body === 'string' ? entry.body : body,
      };
    }
  }
}

function sourceIdentity(padId: PadId, handoff: Record<string, unknown>, source: string): string {
  for (const key of [
    'capture_session_id',
    'session_id',
    'pad_session_id',
    'sketch_session_id',
    'notepad_session_id',
  ]) {
    const value = handoff[key];
    if (typeof value === 'string' && value.trim()) return `${padId}:${value.trim()}`;
  }
  // Older root and per-session handoffs may omit an id; normalize the session
  // path to its root handoff so the same capture remains idempotent.
  return `${padId}:${source.replace(/[\\/]sessions[\\/][^\\/]+[\\/]handoff\.json$/u, '/handoff.json')}`;
}

function listAllRecords(store: PadRecordStore) {
  const records = [];
  let cursor: string | undefined;
  do {
    const page = store.list({ limit: 100, cursor });
    records.push(...page.records);
    cursor = page.next_cursor;
  } while (cursor);
  return records;
}

export function migrateLegacyPads(
  options: { dryRun?: boolean; roots?: string[]; storageRoot?: string } = {}
): MigrationReport {
  const report: MigrationReport = {
    ok: true,
    mode: options.dryRun === false ? 'apply' : 'dry-run',
    scanned: 0,
    migrated: 0,
    held: 0,
    items: [],
  };
  for (const root of options.roots ?? legacyRoots()) {
    const padId = path.basename(root);
    if (!isPadId(padId)) continue;
    for (const source of handoffs(root)) {
      report.scanned += 1;
      let handoff: Record<string, unknown>;
      try {
        handoff = readJson<Record<string, unknown>>(source);
      } catch {
        report.held += 1;
        report.items.push({
          pad_id: padId,
          source,
          status: 'held',
          reason: 'invalid handoff JSON',
        });
        continue;
      }
      const scope = handoff.scope;
      const scopeValue = scope as Record<string, unknown> | null;
      const derivedScopeKind =
        scopeValue && typeof scopeValue === 'object'
          ? String(scopeValue.scope_kind ?? (scopeValue.tenant_slug ? 'tenant' : 'system'))
          : '';
      const scopeTier = scopeValue && typeof scopeValue === 'object' ? String(scopeValue.tier) : '';
      if (
        !scopeValue ||
        !['system', 'tenant', 'organization', 'project', 'mission', 'task', 'session'].includes(
          derivedScopeKind
        ) ||
        !['public', 'confidential', 'personal'].includes(scopeTier) ||
        (scopeTier !== 'public' && typeof scopeValue.tenant_slug !== 'string')
      ) {
        report.held += 1;
        report.items.push({
          pad_id: padId,
          source,
          status: 'held',
          reason: 'tenant or tier is missing; no scope was inferred',
        });
        continue;
      }
      const typedScope = scope as {
        scope_kind?:
          'system' | 'tenant' | 'organization' | 'project' | 'mission' | 'task' | 'session';
        tier: 'public' | 'confidential' | 'personal';
        tenant_slug?: string;
        organization_id?: string;
        project_id?: string;
        mission_id?: string;
        task_id?: string;
      };
      const principal =
        typeof handoff.viewer_principal === 'string' ? handoff.viewer_principal : '';
      const body = readBody(padId, handoff);
      const artifactScan = readLegacyArtifacts(padId, handoff);
      const artifacts = artifactScan.artifacts;
      const minutesScan =
        padId === 'meeting-notepad'
          ? readMeetingMinutes(handoff)
          : {
              fields: { summary: '', decisions: '', action_items: '', open_questions: '' },
              omitted: [],
            };
      const omitted = [...artifactScan.omitted, ...minutesScan.omitted];
      if (!principal || body === undefined || omitted.length > 0) {
        report.held += 1;
        const heldReasons = [
          ...(!principal ? ['viewer principal is missing'] : []),
          ...(body === undefined ? ['content path is missing'] : []),
          ...(omitted.length
            ? [`移行元ファイルを完全には移行できません: ${omitted.join('、')}`]
            : []),
        ];
        report.items.push({
          pad_id: padId,
          source,
          status: 'held',
          ...(body !== undefined
            ? { content_sha256: createHash('sha256').update(body).digest('hex') }
            : {}),
          reason: heldReasons.join('; '),
        });
        continue;
      }
      const content_sha256 = createHash('sha256').update(body).digest('hex');
      const artifactFingerprint = artifacts
        .map(
          (artifact) =>
            `${artifact.field_id}:${createHash('sha256').update(Buffer.from(artifact.data_base64, 'base64')).digest('hex')}`
        )
        .sort()
        .join('|');
      const payload = canonicalPayload(padId, handoff, body, artifacts, minutesScan);
      const payloadFingerprint = createHash('sha256')
        .update(
          JSON.stringify(
            Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)))
          )
        )
        .digest('hex');
      const sourceKey = sourceIdentity(padId, handoff, source);
      const sourceDigest = createHash('sha256').update(sourceKey).digest('hex').slice(0, 32);
      const artifactDigest = createHash('sha256').update(artifactFingerprint).digest('hex');
      // Keep the key below the storage ceiling while retaining the legacy
      // source, body, attachment, canonical payload, and schema revision.
      // Hashing the complete tuple also avoids PadRecordStore's 200-character
      // ceiling truncating one of the identity axes.
      const migrationIdentity = createHash('sha256')
        .update(
          JSON.stringify({
            source: sourceDigest,
            content_sha256,
            artifact_sha256: artifactDigest,
            payload_sha256: payloadFingerprint,
          })
        )
        .digest('hex');
      const idempotencyKey = `legacy:${LEGACY_MIGRATION_SCHEMA}:${migrationIdentity}`;
      const item: MigrationItem = {
        pad_id: padId,
        source,
        status: options.dryRun === false ? 'migrated' : 'ready',
        content_sha256,
      };
      if (options.dryRun === false) {
        const handoffRef = toRepoRelative(source);
        const store = new PadRecordStore(
          {
            scope_kind: typedScope.scope_kind ?? (typedScope.tenant_slug ? 'tenant' : 'system'),
            tier: typedScope.tier,
            ...(typedScope.tenant_slug ? { tenant_slug: typedScope.tenant_slug } : {}),
            ...(typedScope.organization_id ? { organization_id: typedScope.organization_id } : {}),
            ...(typedScope.project_id ? { project_id: typedScope.project_id } : {}),
            ...(typedScope.mission_id ? { mission_id: typedScope.mission_id } : {}),
            ...(typedScope.task_id ? { task_id: typedScope.task_id } : {}),
          },
          principal,
          padId,
          undefined,
          options.storageRoot
        );
        const existing = listAllRecords(store).find(
          (record) => record.idempotency_key === idempotencyKey
        );
        if (existing) {
          item.status = 'skipped';
          item.reason = 'already migrated';
          item.record_id = existing.record_id;
          report.items.push(item);
          continue;
        }
        const record = store.save({
          title: typeof handoff.title === 'string' ? handoff.title : '',
          body,
          artifact_manifest: artifacts.map((artifact) => artifact.name),
          artifacts,
          adapter_id: `${padId}.v1`,
          adapter_schema_version: '1',
          payload,
          idempotency_key: idempotencyKey,
          handoff_ref: handoffRef,
          now: nowIso(),
        });
        if (record.content_sha256 !== content_sha256) {
          throw new Error('migration hash verification failed');
        }
        item.record_id = record.record_id;
        report.migrated += 1;
      }
      report.items.push(item);
    }
  }
  return report;
}

export const main = defineScript({
  name: 'personal-pads:migrate',
  flags: ['json', 'dry-run'],
  run: ({ argv, print }) => {
    const report = migrateLegacyPads({ dryRun: !argv.includes('--apply') });
    print(report);
    return report;
  },
});

if (isDirectScript(import.meta.url, 'migrate.ts') || isDirectScript(import.meta.url, 'migrate.js'))
  void main();
