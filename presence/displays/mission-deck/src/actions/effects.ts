/**
 * Governed effects. Each one delegates to the single owner of that effect:
 *  - conversation  → runSurfaceMessageConversation (no write authority here)
 *  - mission steer → enqueueSurfaceAgentInput (agent-input-queue)
 *  - agent reply / interrupt → herdr pane runtime (prompt / send-keys esc)
 *  - mission lifecycle → mission_controller subprocess (async; UI never blocks)
 * Approvals and terminal attach are TTY handoffs (see handoff.ts), so the
 * governed CLI keeps ownership of its human challenge.
 * Every effect is recorded in the audit chain.
 */
import * as path from 'node:path';
import { runSurfaceMessageConversation } from '@agent/core/surface/channel-surface';
import { enqueueSurfaceAgentInput } from '@agent/core/agent/agent-input-queue';
import { resolveHerdrBin } from '@agent/core/tool/tool-binary-resolvers';
import { safeExecResultAsync } from '@agent/core/secure-io';
import { safeChildEnv, getRegisteredEnvText } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { auditChain } from '@agent/core/governance/audit-chain';
import type { SupportedLocale } from '@agent/core/locale';

export const DECK_AGENT_ID = 'mission-deck';
export const DECK_CHANNEL = 'mission-deck';

export interface EffectResult {
  ok: boolean;
  message: string;
  /** Intent-resolution summary returned by the conversation path. */
  intent?: { understood?: string; shape?: string; next?: string; missing?: string[] };
}

export type MissionVerb = 'pause' | 'resume' | 'checkpoint';

export type DeckRequest =
  | { op: 'ask'; text: string; threadTs: string; locale?: SupportedLocale }
  | {
      op: 'steer';
      missionId: string;
      text: string;
      delivery: 'steer' | 'follow_up';
      tier?: string;
      tenantSlug?: string;
    }
  | { op: 'agentPrompt'; target: string; text: string }
  | { op: 'agentInterrupt'; target: string }
  | { op: 'mission'; verb: MissionVerb; missionId: string; note?: string };

export interface ExecRunner {
  (command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }>;
}

const defaultRunner: ExecRunner = async (command, args, timeoutMs) => {
  const result = await safeExecResultAsync(command, args, {
    cwd: pathResolver.rootDir(),
    timeoutMs,
    env: { ...safeChildEnv() },
  });
  const output = [result.stdout, result.stderr]
    .map((chunk) => chunk?.trim())
    .filter(Boolean)
    .join('\n');
  return {
    ok: result.status === 0 && !result.error,
    output: result.error ? `${output}\n${result.error.message}`.trim() : output,
  };
};

/** A hung reasoning backend must not leave the deck "busy" forever. */
export const ASK_TIMEOUT_MS = 180_000;

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)),
      ms
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface EffectDeps {
  /** Overrides ASK_TIMEOUT_MS (tests). */
  askTimeoutMs?: number;
  run: ExecRunner;
  converse: typeof runSurfaceMessageConversation;
  enqueue: typeof enqueueSurfaceAgentInput;
  audit: (operation: string, result: EffectResult, metadata?: Record<string, unknown>) => void;
}

export function auditEffect(
  operation: string,
  result: EffectResult,
  metadata?: Record<string, unknown>
): void {
  if (getRegisteredEnvText('KYBERION_TUI_DISABLE_AUDIT') === '1') return;
  try {
    auditChain.record({
      agentId: DECK_AGENT_ID,
      action: 'tui_action',
      operation,
      result: result.ok ? 'completed' : 'failed',
      reason: result.message.slice(0, 500),
      metadata,
    });
  } catch {
    // audit failure must never take the operator UI down
  }
}

export const defaultEffectDeps: EffectDeps = {
  run: defaultRunner,
  converse: runSurfaceMessageConversation,
  enqueue: enqueueSurfaceAgentInput,
  audit: auditEffect,
};

function lastLine(output: string): string {
  const lines = output.split('\n').filter((line) => line.trim());
  return lines[lines.length - 1] ?? '';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function missionControllerArgs(
  verb: MissionVerb,
  missionId: string,
  note?: string
): string[] {
  const script = path.join(pathResolver.rootDir(), 'dist', 'scripts', 'mission_controller.js');
  switch (verb) {
    case 'checkpoint':
      return [
        script,
        'checkpoint',
        missionId,
        DECK_AGENT_ID,
        note || 'checkpoint from mission deck',
      ];
    default:
      return [script, verb, missionId];
  }
}

export async function runEffect(
  request: DeckRequest,
  deps: EffectDeps = defaultEffectDeps
): Promise<EffectResult> {
  switch (request.op) {
    case 'ask': {
      try {
        const result = await withTimeout(
          deps.converse({
            surface: 'cli',
            text: request.text,
            channel: DECK_CHANNEL,
            // One thread per deck session keeps conversation continuity.
            threadTs: request.threadTs,
            correlationId: `deck-${Date.now().toString(36)}`,
            receivedAt: new Date().toISOString(),
            ...(request.locale ? { locale: request.locale } : {}),
            actorId: 'operator',
            senderAgentId: `kyberion:${DECK_AGENT_ID}`,
            agentId: 'cli-surface-agent',
            delegationSummaryInstruction:
              'Produce a concise terminal-friendly reply in the operator language. No A2A blocks.',
          } as Parameters<typeof runSurfaceMessageConversation>[0]),
          deps.askTimeoutMs ?? ASK_TIMEOUT_MS,
          'reply'
        );
        const loose = result as {
          text?: string;
          intentResolution?: {
            normalized_intent?: string;
            resolution_shape?: string;
            missing_inputs?: string[];
            next_action?: { label?: string };
          };
        };
        const outcome: EffectResult = {
          ok: true,
          message: loose.text?.trim() ?? '',
          ...(loose.intentResolution
            ? {
                intent: {
                  understood: loose.intentResolution.normalized_intent,
                  shape: loose.intentResolution.resolution_shape,
                  next: loose.intentResolution.next_action?.label,
                  missing: loose.intentResolution.missing_inputs ?? [],
                },
              }
            : {}),
        };
        deps.audit('ask', { ok: true, message: request.text.slice(0, 200) });
        return outcome;
      } catch (err) {
        const outcome = { ok: false, message: errorText(err) };
        deps.audit('ask', outcome);
        return outcome;
      }
    }
    case 'steer': {
      try {
        const entry = await deps.enqueue({
          missionId: request.missionId,
          delivery: request.delivery,
          text: request.text,
          surface: 'terminal',
          channel: DECK_CHANNEL,
          ...(request.tier ? { tier: request.tier as never } : {}),
          ...(request.tenantSlug ? { tenantSlug: request.tenantSlug } : {}),
        });
        const outcome = { ok: true, message: String((entry as { id?: string }).id ?? 'queued') };
        deps.audit('steer', outcome, { missionId: request.missionId, delivery: request.delivery });
        return outcome;
      } catch (err) {
        const outcome = { ok: false, message: errorText(err) };
        deps.audit('steer', outcome, { missionId: request.missionId });
        return outcome;
      }
    }
    case 'agentPrompt': {
      const result = await deps.run(
        resolveHerdrBin(),
        ['agent', 'prompt', request.target, request.text],
        30_000
      );
      const outcome = { ok: result.ok, message: lastLine(result.output) };
      deps.audit('agent_prompt', outcome, { target: request.target });
      return outcome;
    }
    case 'agentInterrupt': {
      const result = await deps.run(
        resolveHerdrBin(),
        ['agent', 'send-keys', request.target, 'esc'],
        15_000
      );
      const outcome = { ok: result.ok, message: lastLine(result.output) };
      deps.audit('agent_interrupt', outcome, { target: request.target });
      return outcome;
    }
    case 'mission': {
      const result = await deps.run(
        'node',
        missionControllerArgs(request.verb, request.missionId, request.note),
        180_000
      );
      const outcome = { ok: result.ok, message: lastLine(result.output) };
      deps.audit(`mission_${request.verb}`, outcome, { missionId: request.missionId });
      return outcome;
    }
  }
}
