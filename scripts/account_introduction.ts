/** Existing-account registration CLI. Human decisions stay on the approval surface. */
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { withExecutionContextAsync } from '@agent/core/authority';
import { assertSafeRepositoryPath, withSensitivePathMediation } from '@agent/core/secure-io';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import {
  resolveCliApprovalRequester,
  resolveCliOperatorIdentity,
} from '@agent/core/governance/cli-operator-principal';
import { computeApprovalPayloadHash } from '@agent/core/governance/approval-store';
import type { OnboardingAuthorityPrincipal } from '@agent/core/organization/onboarding-authority';
import {
  previewAccountIntroduction,
  proposeAccountIntroduction,
  accountIntroductionStatus,
  applyAccountIntroduction,
} from '@agent/core/secret/account-introduction';
import { withSecretResolutionSession } from '@agent/core/foundation/secret-resolution-session';
import { defineScript, isDirectScript } from './lib/harness.js';
import { inspectInstalledIdentity } from './lib/installed-identity.js';
import { readSafeJsonFile } from './lib/json-input.js';
import { readHiddenToken } from './lib/hidden-token-input.js';

type Action = 'preview' | 'request' | 'status' | 'apply';
function parse(argv: string[]) {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        json: { type: 'boolean' },
        review: { type: 'string' },
        'approval-id': { type: 'string' },
      },
    });
  } catch {
    // The parser's native error may include a mistakenly supplied token value.
    throw new Error(
      '[ACCOUNT_CLI] Unsupported option. Tokens must only be entered at the hidden prompt after approval.'
    );
  }
  const [action, bindingId] = parsed.positionals;
  if (
    !['preview', 'request', 'status', 'apply'].includes(action ?? '') ||
    !bindingId ||
    parsed.positionals.length !== 2 ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(bindingId)
  )
    throw new Error(
      '[ACCOUNT_CLI] Unsupported arguments. Usage: account preview|request|status|apply <binding-id> [--review PATH | --approval-id ID] [--json]'
    );
  const seen = new Set<string>();
  for (const token of parsed.tokens ?? []) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error('[ACCOUNT_CLI] Duplicate option refused.');
    seen.add(token.name);
  }
  const flags = parsed.values;
  const allowed =
    action === 'request'
      ? ['json', 'review']
      : ['status', 'apply'].includes(action)
        ? ['json', 'approval-id']
        : ['json'];
  if (Object.keys(flags).some((key) => !allowed.includes(key)))
    throw new Error('[ACCOUNT_CLI] Unsupported option for this registration step.');
  if (action === 'request' && (typeof flags.review !== 'string' || !flags.review))
    throw new Error(
      '[ACCOUNT_CLI] Request requires --review with the exact reviewed preview JSON.'
    );
  if (
    ['status', 'apply'].includes(action) &&
    (typeof flags['approval-id'] !== 'string' ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(flags['approval-id']))
  )
    throw new Error('[ACCOUNT_CLI] A valid --approval-id is required.');
  return { action: action as Action, bindingId, flags };
}

/** No injected identity, collector, or input data in the production entrypoint. */
export async function runAccountIntroductionCli(argv: string[]): Promise<unknown> {
  const { action, bindingId, flags } = parse(argv);
  const installed = inspectInstalledIdentity();
  if (!installed.ready || installed.source !== 'local')
    throw new Error(
      '[ACCOUNT_CLI] Run account registration in the installed owner checkout with its existing identity.'
    );
  return withSecretResolutionSession(() =>
    withExecutionContextAsync('sovereign_concierge', () =>
      withSensitivePathMediation(async () => {
        const owner = resolveCliOperatorIdentity();
        if (!owner.principalId)
          throw new Error('[ACCOUNT_CLI] Existing registered operator identity required.');
        const requester = resolveCliApprovalRequester({ legacy: 'account-introduction' });
        const principal: OnboardingAuthorityPrincipal = {
          requesterId: requester.actorId,
          accountableId: owner.principalId,
          personalOwner: true,
          tenantSlugs: 'all',
        };
        if (action === 'preview') return previewAccountIntroduction(principal, bindingId);
        if (action === 'request') {
          const file = assertSafeRepositoryPath(String(flags.review), {
            allowMissingLeaf: false,
          });
          const relative = path.relative(resolveActiveProfileRoot(), file);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error(
              '[ACCOUNT_CLI] Reviewed metadata must be under the active personal profile.'
            );
          const reviewed = readSafeJsonFile<Record<string, unknown>>(
            file,
            'Account registration review'
          );
          const current = previewAccountIntroduction(principal, bindingId);
          if (
            reviewed.binding_id !== bindingId ||
            computeApprovalPayloadHash({ value: reviewed }) !==
              computeApprovalPayloadHash({ value: current })
          )
            throw new Error(
              '[ACCOUNT_CLI] Review changed. Create and review a fresh preview with the same initiating identity.'
            );
          return proposeAccountIntroduction(principal, bindingId, {
            digest: current.digest,
            expected_generation: current.expected_generation,
          });
        }
        const approvalId = String(flags['approval-id']);
        const status = accountIntroductionStatus(principal, bindingId, approvalId);
        if (action === 'status') return status;
        if (!status.can_apply)
          throw new Error(
            '[ACCOUNT_CLI] This approval cannot be applied. Check its status and approval URL before collecting tokens.'
          );
        const preview = previewAccountIntroduction(principal, bindingId);
        const material: Record<string, string> = {};
        try {
          for (const ref of preview.secret_refs) {
            if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(ref))
              throw new Error('[ACCOUNT_CLI] Invalid token reference.');
            material[ref] = await readHiddenToken(`${ref} (hidden): `);
          }
          // Human collection may take minutes: the existing facade also rechecks under its lock.
          if (!accountIntroductionStatus(principal, bindingId, approvalId).can_apply)
            throw new Error(
              '[ACCOUNT_CLI] Approval changed during token entry. No value was applied.'
            );
          return await applyAccountIntroduction(principal, bindingId, {
            approval_id: approvalId,
            material,
          });
        } finally {
          for (const key of Object.keys(material)) delete material[key];
        }
      })
    )
  );
}

export async function main(argv: string[], print: (value: unknown) => void): Promise<unknown> {
  const result = await runAccountIntroductionCli(argv);
  print(result);
  return result;
}

export const runAccountIntroduction = defineScript({
  name: 'account',
  flags: ['json'],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'account_introduction.ts') ||
  isDirectScript(import.meta.url, 'account_introduction.js')
)
  void runAccountIntroduction();
