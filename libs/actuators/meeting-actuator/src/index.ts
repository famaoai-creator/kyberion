/**
 * Meeting Actuator — abstracts Zoom / Teams / Google Meet behind a
 * single ADF surface (join / leave / speak / listen / chat / status).
 *
 * Guardrails (audit-load-bearing):
 *
 *   1. **Voice consent gate** — `speak` is refused unless the active
 *      mission's evidence/voice-consent.json declares
 *      `consent: granted` from the operator (or sudo override).
 *   2. **Audit emission** — every action emits a `meeting.<verb>`
 *      audit-chain entry with `tenant_slug` (when set), platform, and
 *      a redacted reference to the meeting URL. Failures emit a
 *      `meeting.<verb>_failed` event with the error reason.
 *   3. **Persona binding** — when a tenant slug is set on the active
 *      identity, the audit entry inherits it so per-tenant SIEMs see
 *      only their own meeting activity.
 *
 * The Python `meeting-bridge.py` is a thin platform driver. Real
 * Zoom / Teams / Meet integration is a deployment-time concern (drop
 * in a vendor SDK behind the same JSON contract).
 */

import {
  logger,
  safeExec,
  safeReadFile,
  safeExistsSync,
  pathResolver,
  auditChain,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MeetingAction {
  action: 'join' | 'leave' | 'speak' | 'listen' | 'chat' | 'status';
  params: {
    platform: 'zoom' | 'teams' | 'meet' | 'auto';
    url?: string;
    meeting_id?: string;
    passcode?: string;
    text?: string;
    duration_sec?: number;
  };
}

export interface MeetingActionResult {
  status: 'success' | 'error' | 'denied';
  platform?: string;
  method?: string;
  message?: string;
  audit_event_id?: string;
  /**
   * Set true on `listen` when the bridge could not deliver a complete
   * transcript (timeout, partial connection, dropped audio chunks).
   * Downstream `extract_action_items` propagates this onto every item
   * as `partial_state=true`, which fail-closes self-execution and
   * tracking until an operator reviews. (Ops-3 from the
   * meeting-facilitator outcome simulation.)
   */
  partial_state?: boolean;
  /** Optional reason string when `partial_state=true`. */
  partial_reason?: string;
  /** Optional transcript path when listen succeeds (or partially does). */
  transcript_path?: string;
}

/**
 * Voice consent gate — only `speak` is gated. The mission evidence
 * directory must contain `voice-consent.json` with `consent: 'granted'`.
 * Operators with `KYBERION_SUDO=true` may bypass for incident response.
 */
function checkSpeakConsent(): { allowed: boolean; reason?: string } {
  if (process.env.KYBERION_SUDO === 'true') return { allowed: true };
  const missionId = process.env.MISSION_ID;
  if (!missionId) {
    return {
      allowed: false,
      reason: 'speak requires MISSION_ID + voice-consent.json in the mission evidence dir',
    };
  }
  const evidenceDir = pathResolver.missionEvidenceDir(missionId);
  if (!evidenceDir) {
    return { allowed: false, reason: `mission '${missionId}' not found` };
  }
  const consentPath = path.join(evidenceDir, 'voice-consent.json');
  if (!safeExistsSync(consentPath)) {
    return {
      allowed: false,
      reason: `voice-consent.json missing at ${path.relative(pathResolver.rootDir(), consentPath)}`,
    };
  }
  try {
    const consent = JSON.parse(safeReadFile(consentPath, { encoding: 'utf8' }) as string);
    if (consent.consent !== 'granted') {
      return {
        allowed: false,
        reason: `voice-consent.json present but consent != 'granted' (got '${consent.consent}')`,
      };
    }
    return { allowed: true };
  } catch (err: any) {
    return { allowed: false, reason: `failed to parse voice-consent.json: ${err?.message ?? err}` };
  }
}

function redactedTarget(input: MeetingAction): string {
  const url = input.params.url;
  if (!url) return `${input.params.platform}:no-url`;
  try {
    const u = new URL(url);
    return `${input.params.platform}:${u.host}${u.pathname.split('/').slice(0, 3).join('/')}`;
  } catch {
    return `${input.params.platform}:invalid-url`;
  }
}

function recordMeetingEvent(
  input: MeetingAction,
  result: MeetingActionResult,
): string {
  const isDenied = result.status === 'denied';
  const isError = result.status === 'error';
  // Ops-3: a successful listen that returned partial_state still emits
  // a `meeting.listen` (not `_failed`), but the metadata records the
  // partial_state flag so downstream auditors can tell that the
  // resulting action items were quarantined.
  const isPartial = result.partial_state === true;
  const action = isError
    ? `meeting.${input.action}_failed`
    : isDenied
      ? `meeting.${input.action}_denied`
      : isPartial
        ? `meeting.${input.action}_partial`
        : `meeting.${input.action}`;
  try {
    const entry = auditChain.record({
      agentId: 'meeting-actuator',
      action,
      operation: redactedTarget(input),
      result: isDenied ? 'denied' : isError ? 'error' : 'allowed',
      ...(result.message
        ? { reason: result.message }
        : isPartial && result.partial_reason
          ? { reason: result.partial_reason }
          : {}),
      metadata: {
        platform: input.params.platform,
        ...(input.params.meeting_id ? { meeting_id: input.params.meeting_id } : {}),
        ...(input.params.duration_sec !== undefined
          ? { duration_sec: input.params.duration_sec }
          : {}),
        ...(typeof input.params.text === 'string'
          ? { speech_chars: input.params.text.length }
          : {}),
        ...(isPartial ? { partial_state: true } : {}),
        ...(result.partial_reason ? { partial_reason: result.partial_reason } : {}),
        ...(result.transcript_path ? { transcript_path: result.transcript_path } : {}),
      },
    });
    return entry.id;
  } catch (err: any) {
    logger.warn(`[meeting] audit emission failed: ${err?.message ?? err}`);
    return '';
  }
}

export async function handleAction(input: MeetingAction): Promise<MeetingActionResult> {
  // Voice consent gate (only speak() is gated).
  if (input.action === 'speak') {
    const consent = checkSpeakConsent();
    if (!consent.allowed) {
      const denied: MeetingActionResult = {
        status: 'denied',
        platform: input.params.platform,
        message: consent.reason,
      };
      denied.audit_event_id = recordMeetingEvent(input, denied);
      return denied;
    }
  }

  const bridgePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../meeting-bridge.py',
  );
  logger.info(`[MEETING] Executing action: ${input.action} on ${input.params.platform}`);

  let parsed: MeetingActionResult;
  try {
    const raw = safeExec('python3', [bridgePath], {
      input: JSON.stringify(input),
    }).trim();
    if (!raw) {
      parsed = { status: 'error', message: 'meeting-bridge produced no output' };
    } else {
      parsed = JSON.parse(raw) as MeetingActionResult;
    }
  } catch (err: any) {
    parsed = {
      status: 'error',
      platform: input.params.platform,
      message: err?.message ?? String(err),
    };
  }
  parsed.audit_event_id = recordMeetingEvent(input, parsed);
  return parsed;
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputPath = pathResolver.rootResolve(argv.input as string);
  const inputContent = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && (modulePath === entrypoint || entrypoint.endsWith('index.js'))) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}
