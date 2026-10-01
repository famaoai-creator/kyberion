import { withExecutionContext } from '@agent/core/authority';
import {
  migrateBindingOwners,
  rollbackBindingOwners,
} from '@agent/core/service/service-binding-registry';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/**
 * Make every connection's owner explicit (person / organization / operator).
 *
 *   node dist/scripts/migrate_binding_owners.js                      # dry-run: what would change
 *   node dist/scripts/migrate_binding_owners.js --apply              # back up, then write
 *   node dist/scripts/migrate_binding_owners.js --apply --assign-person user:alice
 *   node dist/scripts/migrate_binding_owners.js --rollback <backup_dir>
 *
 * Organization connections (they carry a tenant) are backfilled automatically. A person
 * connection has no member to name, so it is reported as `needs_decision` until you claim it
 * with --assign-person. Operator connections are never inferred.
 */

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new ScriptExitError(2, `${flag} requires a value`);
  return value;
}

export const runMigrateBindingOwners = defineScript({
  name: 'migrate-binding-owners',
  flags: ['json'],
  run(context) {
    const rollback = readFlag(context.argv, '--rollback');
    if (rollback) {
      const restored = withExecutionContext('mission_controller', () =>
        rollbackBindingOwners(rollback)
      );
      context.print(
        context.json ? JSON.stringify({ restored }, null, 2) : `Restored ${restored} record(s).`
      );
      return { restored };
    }
    const assignPerson = readFlag(context.argv, '--assign-person');
    const result = withExecutionContext('mission_controller', () =>
      migrateBindingOwners({
        apply: context.argv.includes('--apply'),
        ...(assignPerson ? { assignPerson } : {}),
      })
    );
    const lines = [
      result.applied ? 'Applied.' : 'Dry-run (nothing written). Add --apply to write.',
      ...result.entries.map(
        (e) => `  ${e.binding_id}: ${e.action}${e.problems ? ` — ${e.problems.join('; ')}` : ''}`
      ),
      ...(result.backup_dir ? [`Backup: ${result.backup_dir}  (--rollback to restore)`] : []),
    ];
    context.print(context.json ? JSON.stringify(result, null, 2) : lines.join('\n'));
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'migrate_binding_owners.ts') ||
  isDirectScript(import.meta.url, 'migrate_binding_owners.js')
)
  void runMigrateBindingOwners();
