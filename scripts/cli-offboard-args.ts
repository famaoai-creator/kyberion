/** Shared `--flag value` parser for the operator CLI workflow verbs. */
export function parseCliWorkflowOptions(args: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith('--')) continue;
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[current] = true;
      continue;
    }
    parsed[current] = next;
    index += 1;
  }
  return parsed;
}

export interface ParsedOffboardCommand {
  scopeType: 'tenant' | 'project';
  scopeId: string;
  tenantSlug?: string;
  organizationId?: string;
  mode: 'dry_run' | 'execute';
  json: boolean;
  approval?: { approved_by: string; purpose: string };
}

/**
 * AL-04 offboarding CLI arguments. Pure and exported so the fail-closed
 * rules (execute needs BOTH --approved-by and --purpose) are unit-testable
 * without touching a scope tree. The library verb refuses an unapproved
 * delete too — this is the earlier, friendlier of the two gates.
 */
export function parseOffboardArgs(args: string[]): ParsedOffboardCommand {
  const [scopeType, scopeId, ...rest] = args;
  if (scopeType !== 'tenant' && scopeType !== 'project') {
    throw new Error(
      `offboard scope must be 'tenant' or 'project' (received: ${scopeType ?? '<none>'})`
    );
  }
  if (!scopeId || scopeId.startsWith('--')) {
    throw new Error(`offboard requires a ${scopeType} id`);
  }

  const options = parseCliWorkflowOptions(rest);
  const mode = options['--execute'] === true ? 'execute' : 'dry_run';
  const json = options['--json'] === true;
  const tenantSlug =
    typeof options['--tenant-slug'] === 'string' ? options['--tenant-slug'] : undefined;
  const organizationId =
    typeof options['--organization-id'] === 'string' ? options['--organization-id'] : undefined;
  const approvedBy = typeof options['--approved-by'] === 'string' ? options['--approved-by'] : '';
  const purpose = typeof options['--purpose'] === 'string' ? options['--purpose'] : '';

  if (mode === 'dry_run') {
    return {
      scopeType,
      scopeId,
      ...(tenantSlug ? { tenantSlug } : {}),
      ...(organizationId ? { organizationId } : {}),
      mode,
      json,
    };
  }
  if (!approvedBy.trim() || !purpose.trim()) {
    throw new Error(
      'offboard --execute deletes a scope: it requires --approved-by <who> and --purpose "<why>". ' +
        'Run without --execute for a dry run.'
    );
  }
  return {
    scopeType,
    scopeId,
    ...(tenantSlug ? { tenantSlug } : {}),
    ...(organizationId ? { organizationId } : {}),
    mode,
    json,
    approval: { approved_by: approvedBy.trim(), purpose: purpose.trim() },
  };
}
