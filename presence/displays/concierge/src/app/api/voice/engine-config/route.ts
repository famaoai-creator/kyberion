import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@agent/core/logger';
import {
  EngineRuntimeOperatorError,
  getOperatorEngineRuntimePreferences,
  updateOperatorEngineRuntimePreferences,
  type EngineRuntimeOperatorUpdate,
} from '@agent/shared-voice/engine-runtime-preferences-operator';
import { resolveEngineConfigOperator } from '../../../../lib/engine-config-access';

export const dynamic = 'force-dynamic';

const logger = createLogger('concierge-engine-config');
const NO_STORE = { 'Cache-Control': 'no-store' };

function reply(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Private profile contents and raw exception text never reach the wire. */
function failure(error: unknown) {
  if (error instanceof EngineRuntimeOperatorError) {
    return reply(
      { ok: false, error: error.code },
      error.code === 'engine_config_conflict' ? 409 : 400
    );
  }
  if (error instanceof Error && error.message.includes('[ENGINE_RUNTIME_OPERATOR_DENIED]')) {
    return reply({ ok: false, error: 'engine_config_local_session_required' }, 403);
  }
  logger.error(
    `engine settings unavailable — ${error instanceof Error ? error.name : 'error'} | next: check the profile engine-runtime.json and its schema`
  );
  return reply({ ok: false, error: 'engine_config_unavailable' }, 500);
}

/**
 * 設定 › エンジン: the local machine's engine runtime defaults (binaries,
 * recorders, streaming bridges, agent runtime). Served by the one server
 * (formerly presence-studio `/engine-config`); the core operator module owns
 * validation, the revision fence and the profile target.
 */
export function GET(req: NextRequest) {
  const access = resolveEngineConfigOperator(req, false);
  if (access.response) return access.response;
  if (!access.principal) return reply({ ok: false, error: access.denial }, access.status);
  try {
    return reply({ ok: true, ...getOperatorEngineRuntimePreferences(access.principal) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: NextRequest) {
  const access = resolveEngineConfigOperator(req, true);
  if (access.response) return access.response;
  if (!access.principal) return reply({ ok: false, error: access.denial }, access.status);
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reply({ ok: false, error: 'invalid_patch' }, 400);
  }
  try {
    const result = updateOperatorEngineRuntimePreferences(
      access.principal,
      body as EngineRuntimeOperatorUpdate
    );
    logger.info(`engine settings saved | principal=${access.principal.principalId}`);
    return reply({ ok: true, ...result });
  } catch (error) {
    return failure(error);
  }
}
