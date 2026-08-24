/**
 * The governed ADF lifecycle. Each phase has one explicit hand-off so a
 * caller cannot execute a draft before preflight or commit.
 */
export type AdfLifecyclePhase = 'draft' | 'preflight' | 'auto-repair' | 'commit' | 'execute';

export interface AdfLifecyclePhaseRecord {
  phase: AdfLifecyclePhase;
  status: 'completed' | 'skipped';
}

export interface AdfLifecycleHooks<Draft, Prepared, Committed, Result> {
  draft: () => Draft | Promise<Draft>;
  preflight: (draft: Draft) => Prepared | Promise<Prepared>;
  autoRepair?: (draft: Draft, error: unknown) => Draft | Promise<Draft>;
  commit: (prepared: Prepared) => Committed | Promise<Committed>;
  execute: (committed: Committed) => Result | Promise<Result>;
}

export interface AdfLifecycleResult<Result> {
  result: Result;
  phases: AdfLifecyclePhaseRecord[];
}

/** Run draft -> preflight -> auto-repair (when needed) -> commit -> execute. */
export async function runAdfLifecycle<Draft, Prepared, Committed, Result>(
  hooks: AdfLifecycleHooks<Draft, Prepared, Committed, Result>
): Promise<AdfLifecycleResult<Result>> {
  const phases: AdfLifecyclePhaseRecord[] = [{ phase: 'draft', status: 'completed' }];
  let draft = await hooks.draft();
  let prepared: Prepared;
  try {
    prepared = await hooks.preflight(draft);
    phases.push({ phase: 'preflight', status: 'completed' });
  } catch (error) {
    if (!hooks.autoRepair) throw error;
    draft = await hooks.autoRepair(draft, error);
    phases.push({ phase: 'auto-repair', status: 'completed' });
    prepared = await hooks.preflight(draft);
    phases.push({ phase: 'preflight', status: 'completed' });
  }
  const committed = await hooks.commit(prepared);
  phases.push({ phase: 'commit', status: 'completed' });
  const result = await hooks.execute(committed);
  phases.push({ phase: 'execute', status: 'completed' });
  return { result, phases };
}
