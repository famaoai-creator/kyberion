import { describe, expect, it, vi } from 'vitest';
import type { Charter } from '../governance/accountability-charter.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import {
  compilePipelineFileRunManifest,
  openRunManifestSession,
  requestPipelineFileTrust,
  type RunManifestSessionDeps,
} from './run-manifest-session.js';

const SCOPE = {
  input_path: 'knowledge/confidential/acme/scenarios/run.json',
  tier: 'confidential' as const,
  tenant_slug: 'acme',
};
const PIPELINE = {
  steps: [
    { op: 'browser:goto', params: { url: '{{base}}/login' } },
    { op: 'browser:fill', params: { selector: '#user', text: 'me' } },
    { op: 'browser:goto', params: { url: '{{next_url}}' } },
  ],
  context: { base: 'https://app.example.test' },
};
const SOURCE = JSON.stringify(PIPELINE);

function charter(modes: string[] = ['attended']): Charter {
  return {
    charter_id: 'rm-charter-1',
    accountable: { actor: 'user:owner', deputies: [] },
    envelope: { principal_modes: modes },
  } as unknown as Charter;
}

const attended = () => ({ mode: 'attended' as const, memberId: 'owner', reason: 'tty' });
const unattended = () => ({ mode: 'unattended' as const, reason: 'no terminal present' });

function open(deps: RunManifestSessionDeps, overrides: Record<string, unknown> = {}) {
  return openRunManifestSession(
    {
      scope: SCOPE,
      sourceText: SOURCE,
      pipeline: PIPELINE,
      hasHuman: true,
      runId: 'run-1',
      ...overrides,
    },
    deps
  );
}

describe('compilePipelineFileRunManifest', () => {
  it('binds the exact source text, path and the static context block', () => {
    const manifest = compilePipelineFileRunManifest({
      scope: SCOPE,
      sourceText: SOURCE,
      pipeline: PIPELINE,
    });
    expect(manifest.source.input_path).toBe(SCOPE.input_path);
    expect(manifest.source.content_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.scope).toEqual({ tier: 'confidential', tenant_slug: 'acme' });
    // `{{base}}` resolves from the context block; `{{next_url}}` stays unbindable.
    expect(manifest.requirements.effects.map((entry) => entry.bindable)).toEqual([
      true,
      true,
      false,
    ]);
    const edited = compilePipelineFileRunManifest({
      scope: SCOPE,
      sourceText: `${SOURCE} `,
      pipeline: PIPELINE,
    });
    expect(edited.manifest_hash).not.toBe(manifest.manifest_hash);
  });
});

describe('openRunManifestSession', () => {
  it('binds the run to the charter of an approved manifest and reports coverage', () => {
    const ensureCharter = vi.fn(() => ({ charter: charter(), created: true }));
    const findApproval = vi.fn(() => 'APR-1');
    const recordRunStart = vi.fn();
    const session = open({
      resolvePrincipal: attended,
      findApproval,
      ensureCharter,
      recordRunStart,
    });
    // Each bound run is auditable on the charter ledger.
    expect(recordRunStart).toHaveBeenCalledWith(charter(), {
      run_id: 'run-1',
      principal_mode: 'attended',
    });
    expect(findApproval).toHaveBeenCalledWith(SCOPE.input_path, session.manifest!.manifest_hash);
    expect(ensureCharter).toHaveBeenCalledWith({
      approvalRequestId: 'APR-1',
      manifest: session.manifest,
    });
    expect(session.binding).toMatchObject({
      charterId: 'rm-charter-1',
      principal: 'attended',
      runId: 'run-1',
    });
    expect(session.message).toBe(
      'run manifest: 2/3 external steps pre-approved (charter rm-charter-1, principal attended)'
    );
    expect(session.level).toBe('info');
    expect(session.admitting).toBe(true);
  });

  it('says why a run is unbound and names the next command', () => {
    const session = open({ resolvePrincipal: attended, findApproval: () => null });
    expect(session.binding).toBeUndefined();
    expect(session.message).toMatch(/^run manifest: not bound — 0\/3 external steps pre-approved/u);
    expect(session.message).toContain(
      `next: pnpm kyberion project-trust request ${SCOPE.input_path}`
    );
  });

  it('stays unbound when the run cannot be recorded on the charter ledger', () => {
    const session = open({
      resolvePrincipal: attended,
      findApproval: () => 'APR-1',
      ensureCharter: () => ({ charter: charter(), created: false }),
      recordRunStart: () => {
        throw new Error('ledger unwritable');
      },
    });
    expect(session.binding).toBeUndefined();
    expect(session.message).toContain('could not be recorded');
  });

  it('stays unbound with a one-line reason when the daily run cap is reached', () => {
    const session = open({
      resolvePrincipal: attended,
      findApproval: () => 'APR-1',
      ensureCharter: () => ({ charter: charter(), created: false }),
      recordRunStart: () => ({
        recorded: false,
        reason: 'daily_cap',
        day: '2026-11-26',
        runs_today: 20,
        runs_per_day: 20,
      }),
    });
    expect(session.binding).toBeUndefined();
    expect(session.level).toBe('warn');
    expect(session.message).toContain('daily run cap reached (20/20 today, UTC 2026-11-26)');
    expect(session.message).toContain(
      `| next: run again after 00:00 UTC, or re-approve with a higher cap: pnpm kyberion project-trust request ${SCOPE.input_path} --runs-per-day <N>`
    );
    expect(session.message).not.toContain('\n');
  });

  it('stays unbound (never fails the run) when the principal cannot be resolved', () => {
    const session = open({
      resolvePrincipal: () => {
        throw new Error('member registry unreadable');
      },
      findApproval: () => 'APR-1',
    });
    expect(session.binding).toBeUndefined();
    expect(session.level).toBe('warn');
    expect(session.message).toContain('the run principal could not be resolved');
    expect(session.message).toContain('member registry unreadable');
  });

  it('stays unbound when the principal cannot be matched to the charter accountable', () => {
    const session = open({
      resolvePrincipal: attended,
      findApproval: () => 'APR-1',
      // A malformed accountable makes principalForAccountable throw.
      ensureCharter: () => ({
        charter: { ...charter(), accountable: null } as unknown as Charter,
        created: false,
      }),
      recordRunStart: () => {
        throw new Error('must not be reached');
      },
    });
    expect(session.binding).toBeUndefined();
    expect(session.level).toBe('warn');
    expect(session.message).toContain('could not be matched to charter rm-charter-1');
  });

  it('warns and stays unbound when the charter cannot be issued', () => {
    const session = open({
      resolvePrincipal: attended,
      findApproval: () => 'APR-1',
      ensureCharter: () => {
        throw new Error('[RUN_MANIFEST_CHARTER] decider is not an active owner of tenant acme');
      },
    });
    expect(session.binding).toBeUndefined();
    expect(session.level).toBe('warn');
    expect(session.message).toContain('not an active owner of tenant acme');
    expect(session.message).toContain('| next: pnpm pipeline check');
  });

  it('flags an unattended principal the approval does not cover', () => {
    const session = open({
      resolvePrincipal: unattended,
      findApproval: () => 'APR-1',
      ensureCharter: () => ({ charter: charter(['attended']), created: false }),
    });
    expect(session.binding?.principal).toBe('unattended');
    expect(session.level).toBe('warn');
    // A binding that pre-approves nothing: callers must not treat the run as bound.
    expect(session.admitting).toBe(false);
    expect(session.message).toContain('0/3 external steps pre-approved');
    expect(session.message).toContain('principal unattended (no terminal present) is NOT approved');
  });

  it('runs a terminal member who is not the approving owner unattended', () => {
    const session = open({
      resolvePrincipal: () => ({ mode: 'attended', memberId: 'colleague', reason: 'tty' }),
      findApproval: () => 'APR-1',
      ensureCharter: () => ({ charter: charter(['attended']), created: false }),
    });
    expect(session.binding?.principal).toBe('unattended');
    expect(session.principal?.reason).toContain('not the approving owner');
    expect(session.message).toContain('0/3 external steps pre-approved');
  });

  it('never attends a library caller claiming hasHuman: true from an agent-driven process', () => {
    vi.stubEnv('CLAUDECODE', '1');
    try {
      // Default principal resolution: the agent marker wins before any member lookup.
      const session = open(
        {
          findApproval: () => 'APR-1',
          ensureCharter: () => ({ charter: charter(), created: false }),
        },
        { hasHuman: true }
      );
      expect(session.binding?.principal).toBe('unattended');
      expect(session.principal?.reason).toMatch(/^agent-driven process/u);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('never binds a resumed run, a workflow module or a tenant-less pipeline', () => {
    const findApproval = vi.fn(() => 'APR-1');
    expect(open({ findApproval }, { resumed: true }).message).toContain('resumed run');
    expect(open({ findApproval }, { sourceText: undefined }).level).toBe('debug');
    expect(
      open({ findApproval }, { scope: { ...SCOPE, tenant_slug: undefined } }).message
    ).toContain('no tenant scope');
    expect(findApproval).not.toHaveBeenCalled();
  });
});

describe('requestPipelineFileTrust', () => {
  const record = { id: 'APR-9', status: 'pending' } as ApprovalRequestRecord;
  const deriveScope = () => ({ ...SCOPE, source: 'location' as const });

  it('opens a v2 request with the manifest, attended-only by default', () => {
    const createRequest = vi.fn(() => record);
    const result = requestPipelineFileTrust({
      inputPath: 'pipelines/baseline-check.json',
      deps: { deriveScope, createRequest },
    });
    expect(result.record).toBe(record);
    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({ principalModes: ['attended'], manifest: result.manifest })
    );
  });

  it('adds unattended only when asked', () => {
    const createRequest = vi.fn(() => record);
    requestPipelineFileTrust({
      inputPath: 'pipelines/baseline-check.json',
      allowUnattended: true,
      deps: { deriveScope, createRequest },
    });
    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({ principalModes: ['attended', 'unattended'] })
    );
  });

  it('passes the daily run cap only when the approver chose one', () => {
    const createRequest = vi.fn(() => record);
    requestPipelineFileTrust({
      inputPath: 'pipelines/baseline-check.json',
      runsPerDay: 3,
      deps: { deriveScope, createRequest },
    });
    expect(createRequest).toHaveBeenCalledWith(expect.objectContaining({ runsPerDay: 3 }));
    requestPipelineFileTrust({
      inputPath: 'pipelines/baseline-check.json',
      deps: { deriveScope, createRequest },
    });
    expect(createRequest.mock.calls[1][0]).not.toHaveProperty('runsPerDay');
    expect(() =>
      requestPipelineFileTrust({
        inputPath: 'knowledge/confidential/acme/flows/run.ts',
        runsPerDay: 3,
        deps: { deriveScope, createFileOnlyRequest: () => record },
      })
    ).toThrow('[PROJECT_TRUST_RUN_LIMIT]');
  });

  it('keeps file-only trust for a workflow module, never with unattended', () => {
    const createFileOnlyRequest = vi.fn(() => record);
    const result = requestPipelineFileTrust({
      inputPath: 'knowledge/confidential/acme/flows/run.ts',
      deps: { deriveScope, createFileOnlyRequest },
    });
    expect(result.manifest).toBeUndefined();
    expect(result.fileOnlyReason).toContain('workflow module');
    expect(() =>
      requestPipelineFileTrust({
        inputPath: 'knowledge/confidential/acme/flows/run.ts',
        allowUnattended: true,
        deps: { deriveScope, createFileOnlyRequest },
      })
    ).toThrow(/unattended runs need a run manifest/u);
  });
});
