/**
 * Show what a charter grant for an approval-queue profile would sign.
 *
 * Usage:
 *   pnpm kyberion browser approval-queue <knowledge/confidential/<tenant>/approval-queues/<system>.json> [--json]
 */

import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import { pathResolver } from '@agent/core/path-resolver';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import {
  approvalQueueSecretName,
  loadApprovalQueueProfile,
} from '../../libs/actuators/browser-actuator/src/approval-queue-inspect.js';

const PROFILE_PATH = /^knowledge\/confidential\/([^/]+)\/approval-queues\/[^/]+\.json$/;

export function describeApprovalQueueProfile(rawPath: string) {
  const absolute = pathResolver.rootResolve(rawPath);
  const relative = path.relative(pathResolver.rootDir(), absolute).split(path.sep).join('/');
  const tenant = PROFILE_PATH.exec(relative)?.[1];
  if (!tenant)
    throw new ScriptExitError(
      1,
      `[APPROVAL_QUEUE_PROFILE_PATH] ${rawPath} is not a tenant approval-queue profile — profiles live in one place only | next: pass knowledge/confidential/<tenant>/approval-queues/<system>.json`
    );
  const { profile, profileHash } = loadApprovalQueueProfile(absolute);
  const { service, user_key, password_key } = profile.credential;
  return {
    tenant,
    profile: relative,
    profile_hash: profileHash,
    delegable: profile.origins.length === 1,
    origins: profile.origins,
    credential: {
      service,
      secrets: [user_key, password_key].map((key) => approvalQueueSecretName(service, key)),
    },
    login_url: profile.login.url,
    navigate: profile.navigate ?? [],
    list: profile.list,
    grant:
      profile.origins.length === 1
        ? {
            operation_id: 'browser:approval_queue_inspect',
            origin: profile.origins[0],
            profile_hash: profileHash,
          }
        : undefined,
  };
}

export async function main(argv: string[], print: (msg: string) => void): Promise<void> {
  const parsed = await createStandardYargs([
    'node',
    'approval_queue_profile_cli',
    ...argv.filter((arg) => arg !== '--'),
  ])
    .command('$0 [profile]', "Show an approval-queue profile's hash and the grant to sign")
    .option('json', { type: 'boolean', default: false, description: 'Output as JSON' })
    .help()
    .parse();
  const json = Boolean(parsed.json);
  const target = typeof parsed.profile === 'string' ? parsed.profile : undefined;
  if (!target)
    throw new ScriptExitError(
      1,
      'Usage: pnpm kyberion browser approval-queue <knowledge/confidential/<tenant>/approval-queues/<system>.json> [--json]'
    );
  const summary = describeApprovalQueueProfile(target);
  if (json) {
    print(JSON.stringify(summary, null, 2));
    return;
  }
  const navigate = summary.navigate.map((step, index) => `  ${index + 1}. ${JSON.stringify(step)}`);
  print(
    [
      `Profile:      ${summary.profile} (tenant ${summary.tenant})`,
      `SHA-256:      ${summary.profile_hash}`,
      `Origins:      ${summary.origins.join(', ')}`,
      `Credential:   ${summary.credential.service} → ${summary.credential.secrets.join(', ')}`,
      `Login URL:    ${summary.login_url}`,
      `Navigate:     ${navigate.length ? '' : '(none)'}`,
      ...navigate,
      `List rows:    ${summary.list.row_selector} (empty: ${summary.list.empty_selector})`,
      '',
      summary.grant
        ? `Grant to sign in the tenant charter's envelope.external_operations:\n${JSON.stringify(summary.grant, null, 2)}`
        : 'Not delegable: the profile declares more than one origin, so each run needs a human approval.',
      'Any byte change to the file changes the SHA-256 and needs a new signature.',
    ].join('\n')
  );
}

export const approvalQueueProfileCli = defineScript({
  name: 'approval-queue-profile-cli',
  flags: ['json', 'quiet'],
  async run(context) {
    await main(context.argv, context.print);
  },
});

if (
  isDirectScript(import.meta.url, 'approval_queue_profile_cli.ts') ||
  isDirectScript(import.meta.url, 'approval_queue_profile_cli.js')
) {
  void approvalQueueProfileCli();
}
