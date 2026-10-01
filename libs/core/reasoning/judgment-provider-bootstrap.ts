/**
 * Judgment provider bootstrap — the "during setup" step the judgment seam
 * names (`selectJudgmentBackend` throws until a floor provider exists).
 *
 * Always registers the built-in rule floor. Additional providers are opt-in,
 * listed by id in `KYBERION_JUDGMENT_PROVIDERS` (comma separated), because
 * each one has a cost the operator must choose: `laya-mlx` starts a resident
 * Python worker on first judgment, `typesafe-jev` sends public-tier state to
 * an external API. Registering a provider never widens what it may see —
 * `selectJudgmentBackend` still filters every call through the provider
 * egress policy — and an id this bootstrap does not know is refused with an
 * operator-visible warning rather than silently ignored.
 *
 * Idempotent: a provider that is already registered is left alone, so a
 * resident worker is never replaced by a second one.
 *
 * See knowledge/product/architecture/judgment-backend-seam.md.
 */

import { getRegisteredEnvText } from '../foundation/env.js';
import { createLogger } from '../logger.js';
import { registerOrganizationWorkJudgment } from '../organization/organization-operating-model-persistence.js';
import { LAYA_MLX_PROVIDER, registerLayaMlxBackend } from '../laya-mlx-judgment-backend.js';
import {
  TYPESAFE_JEV_PROVIDER,
  registerTypeSafeJevBackend,
} from '../typesafe-jev-judgment-backend.js';
import {
  BUILTIN_JUDGMENT_PROVIDER,
  listJudgmentBackends,
  resolveCalibration,
} from './judgment-backend.js';

const logger = createLogger('judgment-provider-bootstrap');

export const JUDGMENT_PROVIDERS_ENV_VAR = 'KYBERION_JUDGMENT_PROVIDERS';

/** Opt-in providers this bootstrap can register, keyed by judgment_id. */
const OPTIONAL_JUDGMENT_PROVIDERS: Readonly<Record<string, () => () => void>> = {
  [LAYA_MLX_PROVIDER]: () => registerLayaMlxBackend(),
  [TYPESAFE_JEV_PROVIDER]: () => registerTypeSafeJevBackend(),
};

/**
 * Unknown ids already warned about. The bootstrap runs on every judgment
 * assist call, so without this a stale env entry would re-warn per call; the
 * refusal itself is still reported in every result.
 */
const warnedRefusedProviders = new Set<string>();

export interface JudgmentProviderBootstrapResult {
  /** Providers registered by this call (already-present ones are not repeated). */
  registered: string[];
  /** Requested ids that are not known providers, with the reason. */
  refused: Array<{ id: string; reason: string }>;
}

export function listOptionalJudgmentProviders(): string[] {
  return Object.keys(OPTIONAL_JUDGMENT_PROVIDERS);
}

function requestedProviders(raw: string | undefined): string[] {
  return Array.from(
    new Set(
      String(raw || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

export function ensureJudgmentBackendsRegistered(
  options: { providers?: string } = {}
): JudgmentProviderBootstrapResult {
  const present = new Set(listJudgmentBackends().map((backend) => backend.judgment_id));
  const result: JudgmentProviderBootstrapResult = { registered: [], refused: [] };

  if (!present.has(BUILTIN_JUDGMENT_PROVIDER)) {
    registerOrganizationWorkJudgment();
    result.registered.push(BUILTIN_JUDGMENT_PROVIDER);
  }

  const raw = options.providers ?? getRegisteredEnvText(JUDGMENT_PROVIDERS_ENV_VAR);
  for (const id of requestedProviders(raw)) {
    const register = OPTIONAL_JUDGMENT_PROVIDERS[id];
    if (!register) {
      const reason = `unknown judgment provider; known: ${listOptionalJudgmentProviders().join(', ')}`;
      result.refused.push({ id, reason });
      if (warnedRefusedProviders.has(id)) continue;
      warnedRefusedProviders.add(id);
      logger.warn(
        `${JUDGMENT_PROVIDERS_ENV_VAR} lists '${id}' — ${reason} | fix the id or remove it | evidence: ${JUDGMENT_PROVIDERS_ENV_VAR}=${raw}`
      );
      continue;
    }
    if (present.has(id)) continue;
    register();
    present.add(id);
    result.registered.push(id);
  }
  return result;
}

/** Kill switch for the calibration-gated judgment assists (`off` disables them). */
export const JUDGMENT_ASSISTS_ENV_VAR = 'KYBERION_JUDGMENT_ASSISTS';

/**
 * Gate for the calibration-gated judgment assists (error category, browser
 * failure kind, knowledge relevance). Those assists default to
 * `requireCalibrated`, so an answer from an unfitted provider is always
 * declined — asking would only cost latency (a resident model worker, an
 * external call) for an outcome that cannot change. This answers "could a call
 * change the outcome?": not switched off, and some registered provider other
 * than the built-in floor has a calibration fit for `questionId`
 * (`judgment-calibration.json`). Registers the providers on first use.
 *
 * False keeps the caller on its deterministic baseline without a model call,
 * which is the state of every call site until a fit lands.
 */
export function judgmentAssistReady(questionId: string): boolean {
  if (getRegisteredEnvText(JUDGMENT_ASSISTS_ENV_VAR) === 'off') return false;
  ensureJudgmentBackendsRegistered();
  return listJudgmentBackends().some(
    (backend) =>
      backend.judgment_id !== BUILTIN_JUDGMENT_PROVIDER &&
      resolveCalibration(backend.judgment_id, questionId)
  );
}
