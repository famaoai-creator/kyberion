import { withExecutionContext } from '@agent/core/governance';
import {
  applyPublicationRoleMigration,
  previewPublicationRoleMigration,
  requestPublicationRoleMigrationApproval,
} from '@agent/core/organization/publication-role-migration';
import { resolveCliApprovalRequester } from '@agent/core/governance/cli-operator-principal';

/** The organization role facade is the only installation migration entrypoint. */
export function runPublicationRoleMigration(args: string[], print: (value: unknown) => void): void {
  let sourceRoot = '';
  let approvalId = '';
  let expectedDigest = '';
  let apply = false;
  let requestApproval = false;
  let dryRun = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--source-root') sourceRoot = args[++index] || '';
    else if (arg === '--approval-id') approvalId = args[++index] || '';
    else if (arg === '--expected-digest') expectedDigest = args[++index] || '';
    else if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--request-approval') requestApproval = true;
    else throw new Error(`Unknown publication role migration option: ${arg}`);
  }
  if (!sourceRoot) throw new Error('Required: --source-root <related-built-worktree>');
  if ([apply, requestApproval, dryRun].filter(Boolean).length > 1)
    throw new Error('Choose only one of --apply, --request-approval or --dry-run');
  if (apply && (!approvalId || !expectedDigest))
    throw new Error(
      'Apply requires --approval-id <authenticated-human-approval> --expected-digest <reviewed-preview-digest>'
    );
  if (requestApproval) {
    if (!expectedDigest)
      throw new Error('Request requires --expected-digest <reviewed-preview-digest>');
    const requester = resolveCliApprovalRequester({ legacy: 'organization-role-migration' });
    const result = withExecutionContext('ecosystem_architect', () =>
      requestPublicationRoleMigrationApproval(sourceRoot, {
        expectedDigest,
        requestedBy: requester.requestedBy,
      })
    );
    print(
      JSON.stringify(
        {
          status: 'pending_human',
          ...result,
          next:
            result.status === 'ready_to_apply'
              ? `Human approval ${result.approvalId} is ready; rerun --apply with that approval id and the reviewed digest.`
              : `An authenticated human must approve ${result.approvalId}; rerun --apply with that approval id and the reviewed digest.`,
        },
        null,
        2
      )
    );
    return;
  }
  const plan = withExecutionContext('ecosystem_architect', () =>
    apply
      ? applyPublicationRoleMigration(sourceRoot, { approvalId, expectedDigest })
      : previewPublicationRoleMigration(sourceRoot)
  );
  print(JSON.stringify({ status: apply ? 'applied' : 'preview', ...plan }, null, 2));
}
