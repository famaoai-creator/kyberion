import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { createLogger } from '@agent/core/logger';
import {
  getVoiceSelectionSnapshot,
  saveVoiceSelectionPreferences,
  voiceSelectionRequestSchema,
} from '@agent/core/voice/voice-selection-preferences';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const logger = createLogger('concierge-voice-selection');
const NO_STORE = { 'Cache-Control': 'no-store' };
/** The preferences live in the personal profile (`knowledge/personal/onboarding/`). */
const PERSONAL_PROFILE_ROLE = 'sovereign_concierge';

/** The selectable engines and the effective choice; the storage path stays internal. */
function publicSnapshot(snapshot: ReturnType<typeof getVoiceSelectionSnapshot>) {
  const { storage_path: _storagePath, ...rest } = snapshot;
  return { ok: true, ...rest };
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
      publicSnapshot(
        withExecutionContext(PERSONAL_PROFILE_ROLE, () => getVoiceSelectionSnapshot())
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
  const body: unknown = await req.json().catch(() => null);
  const parsed = voiceSelectionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message || 'invalid voice selection' },
      { status: 400, headers: NO_STORE }
    );
  }
  try {
    const snapshot = withExecutionContext(PERSONAL_PROFILE_ROLE, () =>
      saveVoiceSelectionPreferences(parsed.data)
    );
    logger.info(
      `voice selection saved | tts=${snapshot.preferences.tts_engine_id ?? '-'} stt=${
        snapshot.preferences.stt_backend ?? '-'
      }`
    );
    return NextResponse.json(publicSnapshot(snapshot), { headers: NO_STORE });
  } catch (error) {
    // An engine that is not selectable on this machine is the caller's input.
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 400, headers: NO_STORE });
  }
}
