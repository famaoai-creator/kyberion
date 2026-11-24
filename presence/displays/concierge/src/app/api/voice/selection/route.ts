import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import {
  listSeamSelectionRules,
  removeSeamSelectionRule,
  setSeamSelectionRule,
} from '@agent/core/seam-selection-rules';
import { getSeamSelectionPolicy } from '@agent/core/seam-provider-selection';
import {
  isLocalVoiceEngine,
  listVoiceEngines,
  VOICE_TTS_ENGINE_SEAM,
} from '@agent/core/voice-engine-registry';
import { requireConciergeInstallationAccess } from '../../../../lib/installation-access';
import { createLogger } from '@agent/core/logger';
import {
  getVoiceSelectionSnapshot,
  saveVoiceSelectionPreferences,
  voiceSelectionRequestSchema,
} from '@agent/shared-voice/voice-selection-preferences';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const logger = createLogger('concierge-voice-selection');
const NO_STORE = { 'Cache-Control': 'no-store' };
/** The preferences live in the personal profile (`knowledge/personal/onboarding/`). */
const PERSONAL_PROFILE_ROLE = 'sovereign_concierge';

/** The not-selectable / unknown engine refusals of `saveVoiceSelectionPreferences` (caller input). */
const SELECTION_REFUSAL = /^(?:Unknown (?:TTS engine|STT backend): |TTS engine '|STT backend ')/u;

const VOICE_PRIORITY_RULE = 'concierge-local-voice-priority';
function prioritySettings() {
  const policy = getSeamSelectionPolicy(VOICE_TTS_ENGINE_SEAM);
  const options = listVoiceEngines('active')
    .filter(
      (engine) =>
        engine.supports.playback &&
        isLocalVoiceEngine(engine) &&
        policy?.providers[engine.engine_id]
    )
    .map(({ engine_id, display_name }) => ({ engine_id, display_name }));
  const order =
    listSeamSelectionRules(VOICE_TTS_ENGINE_SEAM).find(
      (rule) => rule.rule_id === VOICE_PRIORITY_RULE
    )?.prefer ?? [];
  return { options, order };
}
/** The selectable engines and the effective choice; the storage path stays internal. */
function publicSnapshot(snapshot: ReturnType<typeof getVoiceSelectionSnapshot>) {
  const { storage_path: _storagePath, ...rest } = snapshot;
  return { ok: true, ...rest, tts_priority: prioritySettings() };
}

/**
 * Voice engine selection (TTS engine, STT backend), read and saved in-process
 * — it used to be proxied to presence-studio. Reads are guarded like every
 * read route; a save needs Concierge mutation access (same-origin cookie or a
 * localadmin token). Both run as `sovereign_concierge`, the Concierge role for
 * the personal profile, as the setup / me / training routes do.
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    return NextResponse.json(
      withExecutionContext(PERSONAL_PROFILE_ROLE, () =>
        publicSnapshot(getVoiceSelectionSnapshot())
      ),
      { headers: NO_STORE }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const principal = resolved.context.principalId ?? 'anonymous';
  const reject = (error: string) => {
    logger.warn(
      `voice selection refused — ${error} | next: choose a selectable engine | evidence: principal=${principal}`
    );
    return NextResponse.json({ ok: false, error }, { status: 400, headers: NO_STORE });
  };
  const body: unknown = await req.json().catch(() => null);
  if (body && typeof body === 'object' && Object.hasOwn(body, 'tts_priority')) {
    const gate = requireConciergeInstallationAccess(
      resolved.context,
      'write',
      req,
      'voice playback priority'
    );
    if (gate.response) return gate.response;
    const order = (body as { tts_priority: unknown }).tts_priority;
    if (
      Object.keys(body).length !== 1 ||
      !Array.isArray(order) ||
      order.length > 32 ||
      order.some((id) => typeof id !== 'string') ||
      new Set(order).size !== order.length
    )
      return reject('Invalid voice priority order');
    try {
      const saved = withExecutionContext(PERSONAL_PROFILE_ROLE, () => {
        const allowed = new Set(prioritySettings().options.map(({ engine_id }) => engine_id));
        if (order.some((id) => !allowed.has(id))) return undefined;
        if (order.length) {
          setSeamSelectionRule({
            rule_id: VOICE_PRIORITY_RULE,
            seam: VOICE_TTS_ENGINE_SEAM,
            when: { context: { operation: 'speak_local' } },
            prefer: order,
            set_by: principal,
          });
        } else {
          removeSeamSelectionRule(VOICE_PRIORITY_RULE);
        }
        return publicSnapshot(getVoiceSelectionSnapshot());
      });
      return saved
        ? NextResponse.json(saved, { headers: NO_STORE })
        : reject('Unknown engine in voice priority order');
    } catch (error) {
      return conciergeErrorResponse(error, 500);
    }
  }
  const parsed = voiceSelectionRequestSchema.safeParse(body);
  if (!parsed.success) return reject(parsed.error.issues[0]?.message || 'invalid voice selection');
  try {
    const snapshot = withExecutionContext(PERSONAL_PROFILE_ROLE, () =>
      publicSnapshot(saveVoiceSelectionPreferences(parsed.data))
    );
    logger.info(`voice selection saved | principal=${principal}`);
    return NextResponse.json(snapshot, { headers: NO_STORE });
  } catch (error) {
    // Only an unknown / not-ready engine is the caller's input; a storage or
    // role failure is a server error and never echoes its (path-bearing) text.
    const message = error instanceof Error ? error.message : String(error);
    if (SELECTION_REFUSAL.test(message)) return reject(message);
    return conciergeErrorResponse(error, 500);
  }
}
