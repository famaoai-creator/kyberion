import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeLstat, safeStat } from '../secure-io.js';
import { resolveGovernedArtifactPath } from '../workforce/artifact-store.js';
import { resolveIsolatedTextGenerator } from '../provider/isolated-text-generator.js';
import { resolveCodexBinary } from '../provider/codex-cli-query.js';
import {
  assertReasoningEgressAllowed,
  withReasoningPayloadScope,
} from '../reasoning/reasoning-egress-scope.js';
import type { DiscussionProvider, DiscussionScope } from './discussion-types.js';

export interface DiscussionReadinessCheck {
  id:
    | 'scope'
    | 'adapter'
    | 'egress_policy'
    | 'executable'
    | 'artifact_destination'
    | 'live_execution';
  status: 'checked' | 'blocked' | 'unverified';
  code: string;
}
export interface DiscussionReadinessReport {
  provider: DiscussionProvider;
  checked_at: string;
  execution: 'unverified';
  provider_calls: 0;
  checks: DiscussionReadinessCheck[];
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function inspectExecutable(provider: DiscussionProvider): DiscussionReadinessCheck {
  const id = 'executable';
  // Claude's isolated SDK selects its platform-native package inside query().
  // PATH claude is not that executable; discovering it by query would launch it.
  if (provider === 'claude') return { id, status: 'unverified', code: 'executable_unverified' };
  let binary: string;
  try {
    // Only the existing bounded which/where locator, never Codex itself.
    binary = resolveCodexBinary();
  } catch {
    return { id, status: 'unverified', code: 'executable_inspection_unavailable' };
  }
  // Explicit bare commands are PATH-resolved at launch; relative overrides use
  // the isolated launch cwd. Repository-relative stat would invent a result.
  if (!path.isAbsolute(binary))
    return { id, status: 'unverified', code: 'executable_inspection_unavailable' };
  try {
    return safeStat(binary).isFile()
      ? { id, status: 'checked', code: 'executable_present' }
      : { id, status: 'blocked', code: 'executable_missing' };
  } catch (error) {
    return missing(error)
      ? { id, status: 'blocked', code: 'executable_missing' }
      : { id, status: 'unverified', code: 'executable_inspection_unavailable' };
  }
}

function inspectArtifactDestination(): DiscussionReadinessCheck {
  const id = 'artifact_destination';
  let parentsOnly = false;
  try {
    const root = path.resolve(pathResolver.rootDir());
    for (const logical of [
      'active/shared/runtime/discussions',
      'active/shared/runtime/artifacts',
    ]) {
      const target = resolveGovernedArtifactPath(logical);
      let current = target;
      for (;;) {
        const relative = path.relative(root, current);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
          throw new Error('outside repository');
        try {
          const stat = safeLstat(current);
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error('not an ordinary directory');
          parentsOnly ||= current !== target;
          break;
        } catch (error) {
          if (!missing(error) || current === root) throw error;
          current = path.dirname(current);
        }
      }
    }
    return {
      id,
      status: 'checked',
      code: parentsOnly ? 'artifact_parent_inspected' : 'artifact_directory_inspected',
    };
  } catch {
    return { id, status: 'blocked', code: 'artifact_unavailable' };
  }
}

/**
 * Static local prerequisites only: no room, durable execution claim, provider
 * session, credential lookup, login/version probe, model call or write test.
 * Normal governed read/denial auditing remains enabled. This report is not an
 * authorization grant; the actual execution rechecks its authoritative gates.
 */
export function inspectDiscussionReadiness(
  provider: DiscussionProvider,
  scope: DiscussionScope
): DiscussionReadinessReport {
  const tier = scope.tier ?? 'confidential';
  const scoped = tier === 'public' || Boolean(scope.tenant_slug?.trim());
  const checks: DiscussionReadinessCheck[] = [
    {
      id: 'scope',
      status: scoped ? 'checked' : 'blocked',
      code: scoped ? 'scope_checked' : 'tenant_required',
    },
  ];
  let backend: string | undefined;
  try {
    backend = resolveIsolatedTextGenerator(provider).reasoningBackend;
    checks.push({ id: 'adapter', status: 'checked', code: 'adapter_declared' });
  } catch {
    checks.push({ id: 'adapter', status: 'blocked', code: 'adapter_unavailable' });
  }
  if (scoped && backend) {
    try {
      withReasoningPayloadScope(
        {
          tier,
          tenant_slug: scope.tenant_slug,
          purpose: 'discussion:decision',
          training_use: tier === 'public' ? 'training_eligible' : 'no_training',
        },
        () => assertReasoningEgressAllowed(backend)
      );
      checks.push({ id: 'egress_policy', status: 'checked', code: 'egress_allowed' });
    } catch {
      checks.push({ id: 'egress_policy', status: 'blocked', code: 'egress_denied' });
    }
  } else {
    checks.push({ id: 'egress_policy', status: 'unverified', code: 'egress_unverified' });
  }
  checks.push(inspectExecutable(provider), inspectArtifactDestination(), {
    id: 'live_execution',
    status: 'unverified',
    code: 'live_execution_unverified',
  });
  return {
    provider,
    checked_at: new Date().toISOString(),
    execution: 'unverified',
    provider_calls: 0,
    checks,
  };
}
