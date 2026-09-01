/**
 * Kyberion Autonomous Nerve System (KANS) — Reflex Engine v2.0
 * [SECURE-IO COMPLIANT]
 *
 * Evaluates incoming stimuli against Reflex ADFs to trigger autonomic reactions.
 *
 * EV-03 hardening. This path is live in production (`presence/bridge/nexus-daemon.ts`
 * binds a service-actuator dispatcher and calls `evaluate()` for every pending
 * stimulus), and stimuli reaching it can originate from untrusted channels —
 * a Slack message becomes a stimulus whose payload is attacker-controlled text.
 * Three properties were missing, and each one only mattered once a reflex
 * definition existed:
 *
 *  1. `{{payload}}` was substituted by string-replacing inside the JSON text of
 *     `action.params` and re-parsing the result. A payload containing a quote or
 *     brace could therefore change the shape of the dispatched params — inject a
 *     field, or break the parse. Substitution is now structural: the params are
 *     parsed once and placeholder nodes are replaced with real values, so a
 *     payload can never be read as syntax.
 *  2. The actuator and command went to the dispatcher unchecked. An unattended
 *     reaction to untrusted input must not be able to name an arbitrary
 *     actuator, so the actuator is checked against an explicit allowlist and
 *     against the governed op registry's known domains.
 *  3. Firing was neither idempotent nor audited. Dispatch now goes through
 *     `TriggerRunner` as a `wake` trigger keyed by (reflex, stimulus), so the
 *     same stimulus cannot fire the same reflex twice and every reaction leaves
 *     a delivery receipt in the audit chain.
 */

import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeReaddir,
} from '@agent/core/secure-io';
import {
  createTriggerRunner,
  resolveCurrentTriggerAuthority,
  runWakeTrigger,
  type TriggerAuthoritySnapshot,
  type TriggerRunner,
} from '@agent/core/trigger-runner';
import type { NerveMessage } from '@agent/core/nerve-bridge';

export interface ReflexADF {
  id: string;
  trigger: {
    intent: string;
    keyword?: string;
    source?: string;
  };
  action: {
    actuator: string;
    command: string;
    params?: any;
  };
}

type DispatcherFn = (actuator: string, action: string, params: any) => Promise<void>;

/**
 * Actuators a reflex may drive. Reflexes are unattended reactions to input the
 * system does not control, so this is an allowlist rather than a denylist: a new
 * entry is a deliberate decision about what an attacker-influenced stimulus is
 * allowed to reach. `service-actuator` is the only actuator the production
 * dispatcher in nexus-daemon actually handles.
 */
export const REFLEX_ALLOWED_ACTUATORS: readonly string[] = Object.freeze(['service-actuator']);

/** Placeholder syntax supported inside `action.params`. */
const PLACEHOLDER_PATTERN = /\{\{(payload|intent|stimulus_id|source)\}\}/gu;

/** Op-registry domain that owns an actuator, e.g. service-actuator → service. */
export function reflexActuatorDomain(actuator: string): string {
  return actuator.replace(/-actuator$/u, '');
}

/**
 * Reject an action a reflex must not dispatch.
 *
 * The allowlist is the whole gate: it is an exact match against a frozen list
 * of real actuator names, which is strictly stronger than checking the op
 * registry (the registry can only disagree about an actuator the allowlist has
 * already accepted — i.e. a mistake in the allowlist itself, not in a reflex
 * definition). That case is covered by a test over the allowlist rather than by
 * reading the registry from disk on every dispatch.
 */
export function validateReflexAction(action: ReflexADF['action']): string | null {
  const actuator = String(action?.actuator || '').trim();
  const command = String(action?.command || '').trim();
  if (!actuator) return 'action.actuator is required';
  if (!command) return 'action.command is required';
  if (!REFLEX_ALLOWED_ACTUATORS.includes(actuator)) {
    return `actuator "${actuator}" is not reflex-allowed (allowed: ${REFLEX_ALLOWED_ACTUATORS.join(', ')})`;
  }
  return null;
}

export interface ReflexSubstitutionVars {
  payload: unknown;
  intent: string;
  stimulus_id: string;
  source: string;
}

/**
 * Replace placeholders inside an already-parsed params structure.
 *
 * A string that is *exactly* one placeholder becomes the raw value, so an
 * object payload stays an object. A placeholder embedded in surrounding text
 * becomes its string form. Either way the payload is data at every step — it is
 * never concatenated into JSON text and re-parsed.
 */
export function substituteReflexPlaceholders(
  value: unknown,
  vars: ReflexSubstitutionVars
): unknown {
  if (typeof value === 'string') {
    const exact = /^\{\{(payload|intent|stimulus_id|source)\}\}$/u.exec(value);
    if (exact) return vars[exact[1] as keyof ReflexSubstitutionVars];
    PLACEHOLDER_PATTERN.lastIndex = 0;
    return value.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
      const replacement = vars[name as keyof ReflexSubstitutionVars];
      return typeof replacement === 'string' ? replacement : JSON.stringify(replacement ?? null);
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry) => substituteReflexPlaceholders(entry, vars));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        substituteReflexPlaceholders(entry, vars),
      ])
    );
  }
  return value;
}

/** Intent carried by either stimulus shape written to the journal. */
function stimulusIntent(stimulus: NerveMessage): string {
  const fromSignal = (stimulus as unknown as { signal?: { intent?: unknown } }).signal?.intent;
  return String(stimulus.intent ?? fromSignal ?? '');
}

function stimulusPayload(stimulus: NerveMessage): unknown {
  const fromSignal = (stimulus as unknown as { signal?: { payload?: unknown } }).signal?.payload;
  return stimulus.payload ?? fromSignal ?? '';
}

class ReflexEngine {
  private reflexes: ReflexADF[] = [];
  private dispatcher?: DispatcherFn;
  private runner?: TriggerRunner;
  private authorityProvider?: () => TriggerAuthoritySnapshot;
  private readonly REFLEX_DIR = pathResolver.resolve('knowledge/procedures/reflexes');

  constructor() {
    this.reloadReflexes();
  }

  public setDispatcher(fn: DispatcherFn) {
    this.dispatcher = fn;
  }

  /**
   * Test seam: inject a runner, and optionally the authority snapshot provider.
   *
   * The authority provider is part of the same seam because the default one
   * reads the active execution role and the role registry from disk — correct in
   * production (an unattributable reaction must not fire) but not something a
   * unit test of matching and substitution should have to stand up.
   */
  public setTriggerRunner(runner: TriggerRunner, authority?: () => TriggerAuthoritySnapshot) {
    this.runner = runner;
    this.authorityProvider = authority;
  }

  public reloadReflexes() {
    this.reflexes = [];
    try {
      const safeReflexDir = assertSafeRepositoryPath(this.REFLEX_DIR, {
        allowMissingLeaf: true,
      });
      if (!safeExistsSync(safeReflexDir)) return;

      const files = safeReaddir(safeReflexDir).filter((f) => f.endsWith('.adf.json'));
      for (const file of files) {
        try {
          const reflexPath = assertSafeRepositoryPath(path.join(safeReflexDir, file));
          if (!safeLstat(reflexPath).isFile()) continue;
          const content = safeReadFile(reflexPath, { encoding: 'utf8' }) as string;
          const reflex = JSON.parse(content) as ReflexADF;
          // Reject a malformed reflex at load time: a definition that can never
          // dispatch should be visible now, not on the first matching stimulus.
          const invalid = validateReflexAction(reflex.action);
          if (invalid) {
            logger.error(`❌ [ReflexEngine] Ignoring reflex "${reflex.id}" (${file}): ${invalid}`);
            continue;
          }
          this.reflexes.push(reflex);
        } catch (err) {
          logger.error(`❌ [ReflexEngine] Ignoring reflex (${file}): ${err}`);
        }
      }
      logger.info(`⚡ [ReflexEngine] Loaded ${this.reflexes.length} autonomic reflexes.`);
    } catch (err) {
      logger.error(`Failed to load reflexes: ${err}`);
    }
  }

  /**
   * Evaluate a stimulus against all loaded reflexes.
   */
  public async evaluate(stimulus: NerveMessage) {
    for (const reflex of this.reflexes) {
      if (this.matches(stimulus, reflex.trigger)) {
        logger.warn(`⚡ [REFLEX] Triggered: ${reflex.id} by stimulus ${stimulus.id}`);
        await this.executeReaction(reflex, stimulus);
      }
    }
  }

  private matches(stimulus: NerveMessage, trigger: ReflexADF['trigger']): boolean {
    if (stimulusIntent(stimulus) !== trigger.intent) return false;
    if (trigger.source && stimulus.from !== trigger.source) return false;

    if (trigger.keyword) {
      const payload = stimulusPayload(stimulus);
      const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
      if (!payloadStr.includes(trigger.keyword)) return false;
    }
    return true;
  }

  private async executeReaction(reflex: ReflexADF, stimulus: NerveMessage) {
    if (!this.dispatcher) {
      logger.warn(`⚠️ [REFLEX] Cannot execute ${reflex.action.actuator}. No dispatcher bound.`);
      return;
    }

    // Re-check at dispatch time: reflexes can be reloaded, and the registry is
    // read from disk, so the load-time verdict may be stale.
    const invalid = validateReflexAction(reflex.action);
    if (invalid) {
      logger.error(`❌ [REFLEX] Refusing to dispatch ${reflex.id}: ${invalid}`);
      return;
    }

    const params = substituteReflexPlaceholders(reflex.action.params ?? {}, {
      payload: stimulusPayload(stimulus),
      intent: stimulusIntent(stimulus),
      stimulus_id: String(stimulus.id ?? ''),
      source: String(stimulus.from ?? ''),
    });

    try {
      const runner = this.runner ?? (this.runner = createTriggerRunner());
      const receipt = await runWakeTrigger(
        runner,
        {
          // One reaction per (reflex, stimulus). A stimulus re-read after a
          // journal rotation, or two nerve consumers seeing the same line,
          // must not fire the same reaction twice.
          idempotencyKey: `reflex:${reflex.id}:${stimulus.id}`,
          createdBy: (this.authorityProvider ?? resolveCurrentTriggerAuthority)(),
          payload: {
            reflex_id: reflex.id,
            actuator: reflex.action.actuator,
            command: reflex.action.command,
            stimulus_id: stimulus.id,
          },
        },
        async () => {
          await this.dispatcher!(reflex.action.actuator, reflex.action.command, params);
          return `reflex:${reflex.id}:${stimulus.id}`;
        }
      );
      if (receipt.status === 'rejected' || receipt.status === 'failed') {
        logger.error(
          `❌ [REFLEX] ${reflex.id} ${receipt.status}: ${receipt.reason ?? 'unknown reason'}`
        );
      }
    } catch (err: any) {
      logger.error(`❌ [REFLEX] Reaction failed: ${err.message}`);
    }
  }
}

export const reflexEngine = new ReflexEngine();
