/**
 * Reusable conformance suite for isolated text generators
 * (`libs/core/provider/isolated-text-generator.ts`). Every generator that may
 * receive UNTRUSTED text must pass it before its reasoning-provider
 * descriptor declares `isolated_text_generation`.
 *
 * The suite is transport-agnostic: the caller mocks the generator's
 * transport (Agent SDK `query`, `child_process.spawn`, …) in its test file and
 * hands over a {@link IsolatedGeneratorConformanceHarness} that scripts the
 * fake and reports what the generator handed to it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { safeExistsSync } from '../../secure-io.js';
import {
  isIsolatedToolAttemptError,
  resolveIsolatedTextGenerator,
} from '../isolated-text-generator.js';
import { getReasoningProviderDescriptor } from '../../reasoning/reasoning-provider-registry.js';
import type { ReasoningBackendMode } from '../../reasoning/reasoning-backend-policy.js';

/** One transport invocation observed by the fake (query call, spawned child, …). */
export interface IsolatedGeneratorTransportCall {
  /** Working directory handed to the transport, when it has one. */
  cwd?: string;
  /** Whether `cwd` existed while the transport ran. */
  cwdExistedDuringCall?: boolean;
  /** Exact environment handed to the transport. */
  env: Record<string, string>;
  /** True once the generator stopped the transport (abort signal, kill, …). */
  stopped(): boolean;
}

export interface IsolatedGeneratorConformanceHarness {
  generatorId: string;
  /** Reset the fake transport, the event log and egress to "allowed". */
  reset(): void;
  /** Ordered event log; the fake pushes 'egress' and 'transport'. */
  order(): readonly string[];
  /** Make the next egress assertion throw. */
  denyEgress(): void;
  /** Next run: the transport returns `output` as the structured result. */
  scriptSuccess(output: unknown): void;
  /** Next run: the transport signals a tool attempt yet still returns `output`. */
  scriptToolAttempt(output: unknown): void;
  /** Next run: the transport never finishes until stopped. */
  scriptHang(): void;
  /** Version-gated generators: next run reports an isolation-untested version. */
  scriptUntestedVersion?(): void;
  calls(): readonly IsolatedGeneratorTransportCall[];
  /** True when the generator runs its transport in a scratch cwd. */
  usesCwd: boolean;
  /** Root every scratch cwd must live under. */
  scratchRoot?: string;
}

/** Peer secrets stubbed into the parent env; none may reach the transport. */
const PEER_SECRETS: Record<string, string> = {
  KYBERION_PEER_SHARED_SECRET: 'conformance-peer-secret',
  KYBERION_PEER_SHARED_SECRET_NEXT: 'conformance-peer-secret-next',
  MISSION_ID: 'MSN-CONFORMANCE',
  MISSION_ROLE: 'peer_responder_reader',
};

/**
 * Kyberion vars a child may still receive: only the delegation hop counter
 * (recursion guard), which carries no authority or secret.
 */
const ALLOWED_RUNTIME_ENV_KEYS = new Set(['KYBERION_DELEGATION_DEPTH']);

const schema = z.object({ reply: z.string() });

export function describeIsolatedTextGeneratorConformance(
  harness: IsolatedGeneratorConformanceHarness
): void {
  describe(`isolated text generator conformance: ${harness.generatorId}`, () => {
    const generate = (overrides: { abortController?: AbortController; timeoutMs?: number } = {}) =>
      resolveIsolatedTextGenerator(harness.generatorId).generate({
        systemPrompt: 'SYSTEM',
        userPrompt: '<untrusted>peer text</untrusted>',
        schema,
        abortController: overrides.abortController ?? new AbortController(),
        timeoutMs: overrides.timeoutMs ?? 5_000,
      });

    beforeEach(() => {
      vi.unstubAllEnvs();
      harness.reset();
    });

    it('is declared by its reasoning-provider descriptor with the same isolation', () => {
      const generator = resolveIsolatedTextGenerator(harness.generatorId);
      const descriptor = getReasoningProviderDescriptor(
        generator.reasoningBackend as ReasoningBackendMode
      );
      expect(descriptor?.isolated_text_generation?.isolation).toBe(generator.isolation);
    });

    it('asserts egress before any transport, and a denial prevents the transport', async () => {
      harness.scriptSuccess({ reply: 'ok' });
      await expect(generate()).resolves.toEqual({ reply: 'ok' });
      const order = harness.order();
      expect(order[0]).toBe('egress');
      expect(order).toContain('transport');

      harness.reset();
      harness.denyEgress();
      harness.scriptSuccess({ reply: 'ok' });
      await expect(generate()).rejects.toThrow();
      expect(harness.order()).not.toContain('transport');
      expect(harness.calls()).toHaveLength(0);
    });

    it('passes no KYBERION_*/MISSION_* runtime state or peer secret to the transport', async () => {
      for (const [key, value] of Object.entries(PEER_SECRETS)) vi.stubEnv(key, value);
      harness.scriptSuccess({ reply: 'ok' });
      await generate();
      expect(harness.calls().length).toBeGreaterThan(0);
      for (const call of harness.calls()) {
        const leaked = Object.keys(call.env).filter(
          (key) => /^(KYBERION_|MISSION_)/u.test(key) && !ALLOWED_RUNTIME_ENV_KEYS.has(key)
        );
        expect(leaked).toEqual([]);
        for (const secret of Object.values(PEER_SECRETS)) {
          expect(Object.values(call.env)).not.toContain(secret);
        }
      }
    });

    if (harness.usesCwd) {
      it('runs in an existing scratch cwd that is removed afterwards', async () => {
        harness.scriptSuccess({ reply: 'ok' });
        await generate();
        expect(harness.calls().length).toBeGreaterThan(0);
        for (const call of harness.calls()) {
          expect(call.cwd).toBeDefined();
          if (harness.scratchRoot) expect(call.cwd?.startsWith(harness.scratchRoot)).toBe(true);
          expect(call.cwdExistedDuringCall).toBe(true);
          expect(safeExistsSync(call.cwd as string)).toBe(false);
        }
      });
    }

    it('fails closed on a tool attempt and returns no output', async () => {
      harness.scriptToolAttempt({ reply: 'looks fine' });
      const error = await generate().then(
        (value) => ({ returned: value }),
        (caught: unknown) => caught
      );
      expect(error).not.toHaveProperty('returned');
      expect(isIsolatedToolAttemptError(error)).toBe(true);
      if (harness.usesCwd) {
        for (const call of harness.calls()) expect(safeExistsSync(call.cwd as string)).toBe(false);
      }
    });

    it('rejects output that does not match the schema', async () => {
      harness.scriptSuccess({ answer: 'wrong field' });
      await expect(generate()).rejects.toThrow();
    });

    it('abort stops the transport and rejects', async () => {
      harness.scriptHang();
      const abortController = new AbortController();
      const pending = generate({ abortController });
      await vi.waitFor(() => expect(harness.order()).toContain('transport'));
      abortController.abort();
      await expect(pending).rejects.toThrow();
      expect(harness.calls().at(-1)?.stopped()).toBe(true);
    });

    it('the timeout stops the transport and rejects', async () => {
      harness.scriptHang();
      await expect(generate({ timeoutMs: 50 })).rejects.toThrow();
      expect(harness.calls().at(-1)?.stopped()).toBe(true);
    });

    if (resolveIsolatedTextGenerator(harness.generatorId).versionGated) {
      it('a version-gated generator refuses an isolation-untested version', async () => {
        expect(harness.scriptUntestedVersion).toBeTypeOf('function');
        harness.scriptUntestedVersion?.();
        await expect(generate()).rejects.toThrow(/UNTESTED/u);
      });
    }
  });
}
