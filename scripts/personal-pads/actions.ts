/**
 * Typed action seam for the unified local-pads surface.
 *
 * Actions are intentionally separate from HTTP and from the adapter's field
 * renderer.  A new pad can declare actions in `adapters.ts`; the dispatcher
 * below is the only place that binds those declarations to existing Kyberion
 * services.  The browser receives draft patches, never paths or commands.
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  safeExecResultAsync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeUnlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { pathResolver, assertSafeRepositoryPath } from '@agent/core/path-resolver';
import { getSpeechToTextBridge } from '@agent/core/speech-to-text-bridge';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { isLinux, isMacOS } from '@agent/core/platform';
import type { LocalPadContext } from '../lib/local-artifact-pad.js';
import { readOsClipboardText } from '../clipboard-inbox/server.js';
import { generateMeetingMinutes } from '../meeting-notepad/minutes.js';
import { executePersonalWorkbenchAction } from '../personal-workbench/actions.js';
import type { AdapterArtifact, PadActionDescriptor, PadAdapter } from './adapters.js';
import { getPadAdapter } from './adapters.js';
import type { PadId } from './registry.js';
import { PadRecordStore, resolvePadStorage, type PadRecord } from './storage.js';

const activeActionCounts = new Map<string, number>();

export interface PadActionInput {
  pad_id: PadId;
  action_id: string;
  title: string;
  body: string;
  fields: Record<string, unknown>;
  context: LocalPadContext;
  storage_root: string;
  /** Optional adapter supplied by an injected surface host. */
  adapter?: PadAdapter;
  record?: PadRecord;
}

export interface PadDraftPatch {
  /** Values keyed by adapter field id. Data URLs are accepted only as action output. */
  fields?: Readonly<Record<string, string>>;
  body?: string;
  title?: string;
}

export interface PadActionResult {
  action_id: string;
  status: 'succeeded' | 'unavailable' | 'approval_required';
  message: string;
  draft_patch?: PadDraftPatch;
  artifacts?: readonly AdapterArtifact[];
  result?: Readonly<Record<string, unknown>>;
}

export type PadActionAvailabilityStatus = 'ready' | 'permission_required' | 'unavailable';

export interface PadActionAvailability {
  action_id: string;
  status: PadActionAvailabilityStatus;
  message: string;
}

function redactActionResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactActionResult);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/(?:^|_)(?:path|paths|directory|out_dir|file_path|evidence_ref|handoff_ref)$/iu.test(key))
      continue;
    result[key] = redactActionResult(child);
  }
  return result;
}

function descriptor(padId: PadId, actionId: string, adapter?: PadAdapter): PadActionDescriptor {
  const value = (adapter ?? getPadAdapter(padId)).actions.find((action) => action.id === actionId);
  if (!value) throw new Error(`unknown pad action: ${padId}/${actionId}`);
  return value;
}

function fieldText(fields: Record<string, unknown>, key: string): string {
  return typeof fields[key] === 'string' ? fields[key].trim() : '';
}

function parseDataUrl(value: unknown): { mime: string; bytes: Buffer; data_base64: string } {
  if (typeof value !== 'string') throw new Error('managed artifact data is required');
  const match = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/u.exec(value.trim());
  if (!match) throw new Error('managed artifact data must be a base64 data URL');
  const data_base64 = match[2].replace(/\s+/g, '');
  if (!data_base64 || data_base64.length % 4 !== 0)
    throw new Error('managed artifact data is invalid');
  const bytes = Buffer.from(data_base64, 'base64');
  if (!bytes.byteLength || bytes.byteLength > 12 * 1024 * 1024) {
    throw new Error('managed artifact exceeds 12 MiB limit');
  }
  return { mime: match[1] || 'application/octet-stream', bytes, data_base64 };
}

function dataUrl(mime: string, value: string): string {
  return `data:${mime};base64,${value}`;
}

function unavailable(actionId: string, message: string): PadActionResult {
  return { action_id: actionId, status: 'unavailable', message };
}

async function transcribe(input: PadActionInput): Promise<PadActionResult> {
  const audio = parseDataUrl(input.fields.audio_name_data);
  const extension = audio.mime.includes('mp4')
    ? '.m4a'
    : audio.mime.includes('wav')
      ? '.wav'
      : '.webm';
  const root = assertSafeRepositoryPath(pathResolver.sharedTmp('personal-pads-actions'), {
    allowMissingLeaf: true,
  });
  const file = path.join(root, `audio-${randomUUID()}${extension}`);
  safeMkdir(root, { recursive: true });
  safeWriteFile(file, audio.bytes, { mkdir: true });
  try {
    const language = fieldText(input.fields, 'language') || 'ja';
    try {
      const result = await getSpeechToTextBridge().transcribe({ audioPath: file, language });
      const text = String(result.text || '').trim();
      if (!text)
        return unavailable(
          'meeting.transcribe',
          '文字起こし結果が空でした。録音を確認してください。'
        );
      return {
        action_id: 'meeting.transcribe',
        status: 'succeeded',
        message: `文字起こし完了（${result.backend}${result.synthetic ? ' · synthetic' : ''}）`,
        draft_patch: { fields: { transcript: text } },
        result: {
          backend: result.backend,
          synthetic: Boolean(result.synthetic),
          characters: text.length,
        },
      };
    } catch {
      return unavailable(
        'meeting.transcribe',
        'speech-to-text を利用できません。設定と権限を確認してください。'
      );
    }
  } finally {
    safeUnlinkSync(file);
  }
}

async function minutes(input: PadActionInput): Promise<PadActionResult> {
  const notes = fieldText(input.fields, 'notes');
  const transcript = fieldText(input.fields, 'transcript');
  const sourceText = [`## Notes\n${notes}`, `## Transcript\n${transcript}`]
    .filter((value) => value.trim().length > 0)
    .join('\n\n');
  if (!sourceText.trim())
    return unavailable('meeting.minutes', '原メモまたは文字起こしを入力してください。');
  const generated = await generateMeetingMinutes({
    sourceText,
    title: input.title || 'Meeting Minutes',
    language: fieldText(input.fields, 'language') || 'ja',
    attendees: fieldText(input.fields, 'attendees')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    attachmentNames: [
      ...(fieldText(input.fields, 'audio_name') ? [fieldText(input.fields, 'audio_name')] : []),
      ...fieldText(input.fields, 'attachment_name')
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
    ],
    instruction: fieldText(input.fields, 'instruction'),
  });
  const artifact = generated.artifact;
  return {
    action_id: 'meeting.minutes',
    status: 'succeeded',
    message: `議事録の下書きを生成しました（${generated.backend}）。内容を確認して保存してください。`,
    draft_patch: {
      fields: {
        summary: artifact.summary,
        decisions: artifact.decisions.join('\n'),
        handoff: artifact.action_items.join('\n'),
        open_questions: artifact.open_questions.join('\n'),
      },
    },
    result: {
      backend: generated.backend,
      markdown: generated.markdown,
      summary: artifact.summary,
      decisions: artifact.decisions,
      action_items: artifact.action_items,
      open_questions: artifact.open_questions,
    },
  };
}

async function captureScreen(input: PadActionInput): Promise<PadActionResult> {
  const configured = getRegisteredEnvText('KYBERION_SCREENSHOT_PATH')?.trim();
  if (configured) {
    try {
      const bytes = safeReadFile(configured, { encoding: null });
      if (
        !Buffer.isBuffer(bytes) ||
        bytes.byteLength < 8 ||
        bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      ) {
        return unavailable(
          'screenshot.capture-screen',
          'KYBERION_SCREENSHOT_PATH は PNG ではありません。'
        );
      }
      const encoded = bytes.toString('base64');
      return {
        action_id: 'screenshot.capture-screen',
        status: 'succeeded',
        message: '指定された PNG を下書きへ取り込みました。',
        draft_patch: {
          fields: { image_name: 'screenshot.png', image_name_data: dataUrl('image/png', encoded) },
        },
        result: { bytes: bytes.byteLength, source: 'KYBERION_SCREENSHOT_PATH' },
      };
    } catch {
      return unavailable(
        'screenshot.capture-screen',
        '指定 PNG を読めません。設定と権限を確認してください。'
      );
    }
  }
  if (process.platform !== 'darwin') {
    return unavailable(
      'screenshot.capture-screen',
      'OS キャプチャは darwin のみ対応です。画像ファイルを選択してください。'
    );
  }
  const root = assertSafeRepositoryPath(pathResolver.sharedTmp('personal-pads-actions'), {
    allowMissingLeaf: true,
  });
  const file = path.join(root, `screen-${randomUUID()}.png`);
  safeMkdir(root, { recursive: true });
  try {
    const result = await safeExecResultAsync('screencapture', ['-x', file], {
      timeout: 20_000,
      maxOutputMB: 1,
    });
    if (result.status !== 0)
      return unavailable(
        'screenshot.capture-screen',
        '画面キャプチャに失敗しました。権限を確認してください。'
      );
    const bytes = safeReadFile(file, { encoding: null });
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.byteLength < 8 ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    ) {
      return unavailable(
        'screenshot.capture-screen',
        'screencapture が PNG を生成しませんでした。'
      );
    }
    return {
      action_id: 'screenshot.capture-screen',
      status: 'succeeded',
      message: '画面を PNG として下書きへ取り込みました。',
      draft_patch: {
        fields: {
          image_name: 'screenshot.png',
          image_name_data: dataUrl('image/png', bytes.toString('base64')),
        },
      },
      result: { bytes: bytes.byteLength, source: 'screencapture' },
    };
  } finally {
    safeUnlinkSync(file);
  }
}

function csv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 50);
}

function ownerSegment(principal: string): string {
  return createHash('sha256').update(principal).digest('hex').slice(0, 24);
}

function scopedWorkbenchOutDir(input: PadActionInput): string {
  const scopedStorage = resolvePadStorage(
    input.context.scope,
    input.context.viewer_principal,
    'personal-workbench',
    undefined,
    input.storage_root
  );
  return path.join(scopedStorage.handoffs, 'workbench-actions');
}

async function workbench(input: PadActionInput): Promise<PadActionResult> {
  const fields = input.fields;
  const outDir = scopedWorkbenchOutDir(input);
  const common = {
    context: input.context,
    evidenceRef: input.record?.handoff_ref || '',
    outDir,
  };
  switch (input.action_id) {
    case 'workbench.email-draft': {
      const body = fieldText(fields, 'email_body');
      if (!body) return unavailable(input.action_id, 'メール本文を入力してください。');
      const result = await executePersonalWorkbenchAction({
        ...common,
        action: 'email',
        payload: {
          body_markdown: body,
          to: fieldText(fields, 'email_to'),
          subject: fieldText(fields, 'email_subject'),
          account: fieldText(fields, 'email_account'),
        },
      });
      return {
        action_id: input.action_id,
        status: 'succeeded',
        message: 'メール下書きを作成しました（送信は行いません）。',
        result,
      };
    }
    case 'workbench.calendar-propose': {
      const result = await executePersonalWorkbenchAction({
        ...common,
        action: 'calendar',
        payload: {
          stage: 'propose',
          summary: fieldText(fields, 'calendar_summary'),
          start: fieldText(fields, 'calendar_start'),
          end: fieldText(fields, 'calendar_end'),
          description: fieldText(fields, 'calendar_description'),
          location: fieldText(fields, 'calendar_location'),
          attendees: csv(fieldText(fields, 'calendar_attendees')),
          provider: fieldText(fields, 'calendar_provider') || 'google-workspace',
          calendar_id: fieldText(fields, 'calendar_id'),
          time_zone: fieldText(fields, 'calendar_time_zone'),
        },
      });
      return {
        action_id: input.action_id,
        status: String(result.status || '') === 'pending' ? 'approval_required' : 'succeeded',
        message:
          String(result.status || '') === 'pending'
            ? '承認待ちのカレンダー提案を作成しました。'
            : 'カレンダー提案を作成しました。',
        result,
      };
    }
    case 'workbench.calendar-apply': {
      const approvalRequestId = fieldText(fields, 'calendar_approval_request_id');
      if (!approvalRequestId)
        return unavailable(input.action_id, '承認リクエスト ID を入力してください。');
      const result = await executePersonalWorkbenchAction({
        ...common,
        action: 'calendar',
        payload: { stage: 'apply', approval_request_id: approvalRequestId },
        confirmed: fieldText(fields, 'calendar_confirm') === 'yes',
      });
      return {
        action_id: input.action_id,
        status:
          String(result.status || '') === 'approval_required'
            ? 'approval_required'
            : String(result.status || '') === 'reconciliation_required'
              ? 'unavailable'
              : 'succeeded',
        message:
          String(result.status || '') === 'approval_required'
            ? '承認レコードが必要です。明示承認後に再実行してください。'
            : String(result.status || '') === 'reconciliation_required'
              ? '外部反映の結果が未確定です。重複防止のため停止しました。'
              : '承認済みのカレンダー提案を処理しました。',
        result,
      };
    }
    case 'workbench.calendar-reconcile': {
      const approvalRequestId = fieldText(fields, 'calendar_reconcile_approval_request_id');
      if (!approvalRequestId)
        return unavailable(input.action_id, '承認リクエスト ID を入力してください。');
      const result = await executePersonalWorkbenchAction({
        ...common,
        action: 'calendar',
        payload: { stage: 'reconcile', approval_request_id: approvalRequestId },
      });
      const status = String(result.status || '');
      return {
        action_id: input.action_id,
        status:
          status === 'reconciled' || status === 'already_applied' ? 'succeeded' : 'unavailable',
        message:
          status === 'reconciled'
            ? 'provider の一意イベントを照合し、proposal を確定しました。'
            : status === 'already_applied'
              ? 'この proposal は既に確定済みです。'
              : status === 'not_needed'
                ? 'この proposal は照合が必要な状態ではありません。'
                : 'provider の照合結果が一意でないため、proposal は未確定のままです。',
        result,
      };
    }
    case 'workbench.ocr-extract': {
      if (!input.record)
        return unavailable(
          input.action_id,
          'OCR は保存済み record の添付を対象にします。先に保存してください。'
        );
      const artifactId = fieldText(fields, 'ocr_artifact_id');
      if (!artifactId) return unavailable(input.action_id, 'artifact ID を入力してください。');
      const ref = input.record.artifact_refs.find(
        (candidate) => candidate.artifact_id === artifactId
      );
      if (!ref)
        return unavailable(input.action_id, '指定された artifact ID はこの record にありません。');
      const artifact = new PadRecordStore(
        input.context.scope,
        input.context.viewer_principal,
        input.record.pad_id,
        input.record.storage_policy_id,
        input.storage_root
      ).readArtifact(input.record.record_id, artifactId);
      if (!artifact)
        return unavailable(input.action_id, '添付 artifact を安全に読み込めませんでした。');
      const root = assertSafeRepositoryPath(pathResolver.sharedTmp('personal-pads-actions'), {
        allowMissingLeaf: true,
      });
      const extension = ref.mime.includes('png')
        ? '.png'
        : ref.mime.includes('jpeg') || ref.mime.includes('jpg')
          ? '.jpg'
          : '.bin';
      const file = path.join(root, `ocr-${randomUUID()}${extension}`);
      safeMkdir(root, { recursive: true });
      safeWriteFile(file, Buffer.from(artifact.data_base64, 'base64'), { mkdir: true });
      try {
        const result = await executePersonalWorkbenchAction({
          ...common,
          action: 'ocr',
          payload: {
            path: file,
            language: fieldText(fields, 'ocr_language') || undefined,
            mode: fieldText(fields, 'ocr_mode') || 'privacy_first',
            extractStructure: fieldText(fields, 'ocr_extract_structure') === 'yes',
          },
        });
        return {
          action_id: input.action_id,
          status: 'succeeded',
          message: 'scoped artifact の OCR が完了しました。',
          result: { artifact_id: artifactId, ...result },
        };
      } finally {
        safeUnlinkSync(file);
      }
    }
    case 'workbench.knowledge-propose': {
      if (!input.record)
        return unavailable(
          input.action_id,
          '知識候補は保存済み handoff を根拠に作成します。先に保存してください。'
        );
      const summary = fieldText(fields, 'knowledge_summary');
      if (!summary) return unavailable(input.action_id, '候補の要約を入力してください。');
      const result = await executePersonalWorkbenchAction({
        ...common,
        action: 'knowledge',
        payload: { summary },
      });
      return {
        action_id: input.action_id,
        status: 'succeeded',
        message: 'human review 用の知識候補を作成しました。',
        result,
      };
    }
    default:
      throw new Error(`action executor is not registered: ${input.action_id}`);
  }
}

function readScopedWorkingMemory(
  context: LocalPadContext,
  requestedPeriod?: string
):
  { journal: string; todo: string; now: string; paths: Record<string, string | null> } | undefined {
  const tenant = context.scope.tenant_slug?.trim();
  const configuredRoot = getRegisteredEnvText('KYBERION_WORKING_MEMORY_ROOT')?.trim();
  if (!tenant || !configuredRoot) return undefined;
  const root = assertSafeRepositoryPath(configuredRoot, { allowMissingLeaf: true });
  // Personal working-memory is owner-bound as well as tenant-bound.  Never
  // fall back to the legacy unpartitioned `{root}/{tenant}` layout: doing so
  // would let another principal in the same tenant read the journal.
  const tenantRoot = assertSafeRepositoryPath(
    path.join(root, tenant, 'owners', ownerSegment(context.viewer_principal)),
    { allowMissingLeaf: true }
  );
  const periodKey = requestedPeriod?.trim() || currentTokyoPeriodKey();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(periodKey)) throw new Error('period_key is invalid');
  // The current face remains backward compatible at the owner root. Historical
  // periods are explicit subdirectories; never fall back between dates.
  const periodRoot =
    periodKey === currentTokyoPeriodKey()
      ? tenantRoot
      : assertSafeRepositoryPath(path.join(tenantRoot, 'daily', periodKey), {
          allowMissingLeaf: true,
        });
  const files = {
    journal: path.join(periodRoot, 'journal.md'),
    todo: path.join(periodRoot, 'TODO.md'),
    now: path.join(periodRoot, 'NOW.md'),
  };
  const read = (file: string): string =>
    safeExistsSync(file) ? String(safeReadFile(file, { encoding: 'utf8' })) : '';
  return {
    journal: read(files.journal),
    todo: read(files.todo),
    now: read(files.now),
    paths: {
      journal: safeExistsSync(files.journal) ? files.journal : null,
      todo: safeExistsSync(files.todo) ? files.todo : null,
      now: safeExistsSync(files.now) ? files.now : null,
    },
  };
}

function currentTokyoPeriodKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function getPadActionDescriptors(padId: PadId): readonly PadActionDescriptor[] {
  return getPadAdapter(padId).actions;
}

/**
 * Cheap preflight for the shell. It reports capability state without running
 * an action or reading user content; permission prompts still happen only on
 * an explicit click.
 */
export function getPadActionAvailability(
  padId: PadId,
  actionId: string,
  adapter?: PadAdapter
): PadActionAvailability {
  const action = descriptor(padId, actionId, adapter);
  switch (action.capability) {
    case 'os-screenshot':
      if (getRegisteredEnvText('KYBERION_SCREENSHOT_PATH')?.trim()) {
        return {
          action_id: action.id,
          status: 'ready',
          message: '設定済み PNG を取り込めます',
        };
      }
      return isMacOS()
        ? {
            action_id: action.id,
            status: 'permission_required',
            message: 'クリック時に macOS の画面収録権限を確認します',
          }
        : {
            action_id: action.id,
            status: 'unavailable',
            message: 'この OS の画面キャプチャは未対応です',
          };
    case 'os-clipboard':
      return isMacOS() || isLinux()
        ? {
            action_id: action.id,
            status: 'permission_required',
            message: 'クリック時に OS クリップボードを読みます',
          }
        : {
            action_id: action.id,
            status: 'unavailable',
            message: 'この OS のクリップボード読み込みは未対応です',
          };
    case 'speech-to-text':
      try {
        const bridge = getSpeechToTextBridge();
        return {
          action_id: action.id,
          status: 'ready',
          message: `speech-to-text: ${bridge.name}`,
        };
      } catch {
        return {
          action_id: action.id,
          status: 'unavailable',
          message: 'speech-to-text bridge が利用できません',
        };
      }
    case 'reasoning':
    case 'governed':
    default:
      return { action_id: action.id, status: 'ready', message: '利用可能' };
  }
}

/**
 * Action handlers are registered independently from the transport and from
 * the adapter field renderer.  Adding an action extends this table and its
 * adapter declaration; the dispatcher below remains unchanged.
 */
const ACTION_HANDLERS: Readonly<
  Record<string, (input: PadActionInput) => Promise<PadActionResult>>
> = {
  'meeting.transcribe': transcribe,
  'meeting.minutes': minutes,
  'clipboard.read': async (input) => {
    const clipboard = await readOsClipboardText();
    if (!clipboard.ok) {
      return unavailable(
        'clipboard.read',
        'クリップボードを読み込めません。権限と OS 設定を確認してください。'
      );
    }
    return {
      action_id: 'clipboard.read',
      status: 'succeeded',
      message: 'クリップボードを下書きへ読み込みました。',
      draft_patch: { fields: { items: clipboard.text }, body: clipboard.text },
      result: { characters: clipboard.text.length },
    };
  },
  'daily.load-working-memory': async (input) => {
    if (input.context.scope.tier !== 'personal' || !input.context.scope.tenant_slug) {
      return unavailable(
        'daily.load-working-memory',
        'working-memory は tenant-bound personal scope でのみ読み込めます。'
      );
    }
    const faces = readScopedWorkingMemory(
      input.context,
      fieldText(input.fields, 'period_key') || undefined
    );
    if (!faces) {
      return unavailable(
        'daily.load-working-memory',
        'working-memory の tenant binding が未設定です。KYBERION_WORKING_MEMORY_ROOT に管理 root を設定してください。'
      );
    }
    return {
      action_id: 'daily.load-working-memory',
      status: 'succeeded',
      message: 'tenant-bound working-memory を下書きへ読み込みました。',
      draft_patch: {
        fields: {
          journal: faces.journal,
          todo: faces.todo,
          now: faces.now,
          period_key: fieldText(input.fields, 'period_key') || currentTokyoPeriodKey(),
        },
      },
      result: {
        face_paths: faces.paths,
        period_key: fieldText(input.fields, 'period_key') || currentTokyoPeriodKey(),
      },
    };
  },
  'screenshot.capture-screen': captureScreen,
  'workbench.email-draft': workbench,
  'workbench.calendar-propose': workbench,
  'workbench.calendar-apply': workbench,
  'workbench.calendar-reconcile': workbench,
  'workbench.ocr-extract': workbench,
  'workbench.knowledge-propose': workbench,
};

export async function executePadAction(input: PadActionInput): Promise<PadActionResult> {
  const action = descriptor(input.pad_id, input.action_id, input.adapter);
  const key = `${input.pad_id}/${action.id}`;
  const active = activeActionCounts.get(key) ?? 0;
  if (action.max_concurrent !== undefined && active >= action.max_concurrent) {
    return unavailable(action.id, '同じ操作が実行中です。完了してから再度お試しください。');
  }
  activeActionCounts.set(key, active + 1);
  try {
    const handler = ACTION_HANDLERS[action.id];
    if (!handler) throw new Error(`action executor is not registered: ${action.id}`);
    const result = await handler(input);
    return result.result
      ? {
          ...result,
          result: redactActionResult(result.result) as Readonly<Record<string, unknown>>,
        }
      : result;
  } finally {
    const remaining = (activeActionCounts.get(key) ?? 1) - 1;
    if (remaining > 0) activeActionCounts.set(key, remaining);
    else activeActionCounts.delete(key);
  }
}
