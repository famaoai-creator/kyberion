import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The terminal records one stable operator principal on both sides of an
 * approval: the local owner member (`user:<member_id>`) when the CLI opens a
 * request (here: `pnpm onboarding llm attest --request-approval`, which
 * captures the invoker with `captureAttestationInvoker`) and when
 * `pnpm kyberion approvals --approve` decides it. The owner member and the
 * onboarding display name are stubbed; separation of duties is switched on
 * through a customer overlay of the real approval policy.
 */
const identity = vi.hoisted(() => ({ ownerPresent: true, displayName: 'Alice Example' }));

// Separation of duties is switched through a customer overlay of the real
// approval policy, the way an operator enables it.
const sod = vi.hoisted(() => ({ overlayPath: null as string | null, file: '' }));
vi.mock('@agent/core/customer-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/customer-resolver')>();
  return {
    ...actual,
    customerRoot: (subPath = '', ...rest: unknown[]) =>
      subPath === 'policy/approval-policy.json' && sod.overlayPath
        ? sod.overlayPath
        : (actual.customerRoot as (...args: unknown[]) => string | null)(subPath, ...rest),
  };
});

vi.mock('@agent/core/organization/member-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/organization/member-registry')>();
  return {
    ...actual,
    resolveMemberByPrincipal: (input: { source: string }) =>
      input.source === 'loopback' && identity.ownerPresent
        ? {
            member_id: 'owner',
            display_name: identity.displayName,
            status: 'active',
            memberships: [],
            access_registrations: [],
            created_at: '2026-10-01T00:00:00.000Z',
            updated_at: '2026-10-01T00:00:00.000Z',
          }
        : null,
  };
});

// `ps` answers for the terminal-evidence probe when a test scripts the
// process tree; otherwise the real command runs.
const psTree = vi.hoisted(() => ({ parents: null as Map<number, [number, string]> | null }));
vi.mock('@agent/core/secure-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/secure-io')>();
  return {
    ...actual,
    safeExecResult: (command: string, args: string[] = [], options = {}) => {
      if (command !== 'ps' || !psTree.parents) return actual.safeExecResult(command, args, options);
      const pid = Number(args[args.length - 1]);
      if (args.includes('tty=')) return { stdout: 'ttys009\n', stderr: '', status: 0 };
      const entry = pid === process.ppid ? psTree.parents.get(-1) : psTree.parents.get(pid);
      return entry
        ? { stdout: `${entry[0]} ${entry[1]}\n`, stderr: '', status: 0 }
        : { stdout: '', stderr: '', status: 1 };
    },
  };
});

vi.mock('@agent/core/surface/operator-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/surface/operator-identity')>();
  return { ...actual, resolveOperatorDisplayName: () => identity.displayName };
});

import { withExecutionContext } from '@agent/core/authority';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  loadApprovalRequest,
} from '@agent/core/governance/approval-store';
import {
  attestTenantProvider,
  captureAttestationInvoker,
  mutateTenant,
  type AttestationInvoker,
  PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
  requestTenantProviderAttestationApproval,
} from '@agent/core/organization/tenant-governance';
import {
  cliAgentSessionEnv,
  resolveCliApprovalRequester,
} from '@agent/core/governance/cli-operator-principal';
import { evaluateApprovalUsability } from '@agent/core/governance/approval-store';
import { decideApprovalFromCli } from './lib/approval-cli-decision.js';
import { captureCliAttestationInvoker } from './lib/cli-attestation-invoker.js';
import { resetTtyIo, useTerminalEvidence, withTtyAnswer } from './lib/tty-io.test-support.js';
import { auditChain } from '@agent/core/governance/audit-chain';
import { computeApprovalPresentedDigest } from '@agent/core/governance/approval-store';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { main as kyberionHome } from './kyberion_home.js';

function useSeparationOfDutiesOverlay(file: string): void {
  sod.file = file;
}

function setSeparationOfDuties(enabled: boolean): void {
  const product = JSON.parse(
    String(
      safeReadFile(pathResolver.knowledge('product/governance/approval-policy.json'), {
        encoding: 'utf8',
      })
    )
  );
  safeMkdir(path.dirname(sod.file), { recursive: true });
  safeWriteFile(sod.file, JSON.stringify({ ...product, separation_of_duties: { enabled } }));
  sod.overlayPath = sod.file;
}

function clearSeparationOfDuties(): void {
  sod.overlayPath = null;
  if (sod.file) safeRmSync(sod.file, { force: true });
}

function plainTerminal(): void {
  for (const name of cliAgentSessionEnv()) vi.stubEnv(name, '');
}

const claim = {
  slug: 'beta',
  provider: 'codex',
  training_use: 'none' as const,
  plan: 'ChatGPT Enterprise',
  basis: 'https://openai.com/enterprise-privacy',
  attested_by: 'human:owner',
};

describe('terminal approvals record one stable operator principal', () => {
  const parent = pathResolver.sharedTmp('approvals-cli-identity-tests');
  let rootDir = '';
  const requestIds: string[] = [];

  /** `pnpm onboarding llm attest … --request-approval`, as the CLI runs it. */
  function requestFromCli(
    overrides: Partial<typeof claim> = {},
    invoker: AttestationInvoker = captureCliAttestationInvoker()
  ): string {
    const request = withExecutionContext('sovereign_concierge', () =>
      requestTenantProviderAttestationApproval({ ...claim, ...overrides, rootDir, invoker })
    );
    requestIds.push(request.request_id);
    return request.request_id;
  }

  async function approveFromCli(id: string): Promise<void> {
    await kyberionHome(['approvals', '--approve', id]);
  }

  /** `pnpm kyberion approvals --approve|--deny <id>` at an interactive terminal that types the code. */
  function decideFromCliAtTty(id: string, verb: '--approve' | '--deny' = '--approve') {
    return withTtyAnswer(
      (code) => code,
      () => kyberionHome(['approvals', verb, id])
    );
  }

  /** The shared terminal decision with an interactive terminal answering `answer`. */
  function approveAtTty(
    id: string,
    answer: (code: string) => string | null = (code) => code,
    options: { timeoutMs?: number } = {}
  ) {
    return withTtyAnswer(
      answer,
      () => decideApprovalFromCli(stored(id), { decision: 'approved', note: 'tty test' }),
      options
    );
  }

  const stored = (id: string) => loadApprovalRequest(PROVIDER_ATTESTATION_APPROVAL_CHANNEL, id)!;

  beforeEach(() => {
    plainTerminal();
    identity.ownerPresent = true;
    rootDir = path.join(parent, `fixture-${process.pid}-${Date.now()}-${Math.random()}`);
    useSeparationOfDutiesOverlay(path.join(rootDir, 'approval-policy-overlay.json'));
    safeMkdir(path.join(rootDir, 'knowledge', 'personal', 'tenants'), { recursive: true });
    withExecutionContext('sovereign_concierge', () =>
      mutateTenant({ verb: 'create', slug: 'beta', rootDir, apply: true })
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetTtyIo();
    clearSeparationOfDuties();
    for (const id of requestIds.splice(0)) {
      safeRmSync(approvalRequestLogicalPath(PROVIDER_ATTESTATION_APPROVAL_CHANNEL, id), {
        force: true,
      });
    }
    safeRmSync(approvalEventLogicalPath(PROVIDER_ATTESTATION_APPROVAL_CHANNEL), { force: true });
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('with SoD on, refuses the operator approving the request they opened from the CLI', async () => {
    setSeparationOfDuties(true);
    const id = requestFromCli();
    expect(stored(id)).toMatchObject({
      requestedBy: 'user:owner',
      requestedByDisplayName: 'Alice Example',
      requestedByContext: expect.objectContaining({ actorId: 'user:owner' }),
    });

    // Even past the TTY challenge, the store refuses the self-approval.
    await expect(approveAtTty(id)).rejects.toThrow(
      /\[POLICY_VIOLATION\] Separation of duties: approval refused because the decider is the same principal/
    );
    expect(stored(id).status).toBe('pending');
  });

  it('with SoD on, clearing the agent markers is not enough: a non-interactive approve is refused', async () => {
    setSeparationOfDuties(true);
    vi.stubEnv('CLAUDECODE', '1');
    const id = requestFromCli();
    expect(stored(id).requestedBy).toBe('agent:claude-code');

    // `env -u CLAUDECODE -u AI_AGENT pnpm kyberion approvals --approve <id>` from the agent.
    plainTerminal();
    await expect(approveFromCli(id)).rejects.toThrow(
      /^\[APPROVAL_HUMAN_PROOF_REQUIRED\] approval decision blocked — human-only request .* needs terminal attestation and this terminal is not interactive .*signed-in Concierge or Chronos session/
    );
    expect(stored(id).status).toBe('pending');
  });

  it('with SoD on, a wrong TTY challenge answer is refused', async () => {
    setSeparationOfDuties(true);
    vi.stubEnv('CLAUDECODE', '1');
    const id = requestFromCli();
    plainTerminal();
    await expect(approveAtTty(id, () => 'not-the-code')).rejects.toThrow(
      /approval decision cancelled — the typed challenge did not match/
    );
    expect(stored(id).status).toBe('pending');
  });

  it('with SoD on, an unanswered TTY challenge times out and records nothing', async () => {
    setSeparationOfDuties(true);
    vi.stubEnv('CLAUDECODE', '1');
    const id = requestFromCli();
    plainTerminal();
    await expect(approveAtTty(id, () => null, { timeoutMs: 50 })).rejects.toThrow(
      /^\[POLICY_VIOLATION\] challenge timed out/
    );
    expect(stored(id).status).toBe('pending');
  });

  it('with SoD on, the human approves an agent-opened request by answering the TTY challenge', async () => {
    setSeparationOfDuties(true);
    vi.stubEnv('CLAUDECODE', '1');
    const id = requestFromCli();
    plainTerminal();
    await approveAtTty(id);
    expect(stored(id)).toMatchObject({
      status: 'approved',
      decidedBy: 'user:owner',
      decidedByDisplayName: 'Alice Example',
      decidedVia: 'cli_tty_challenge',
      decidedAuthMethod: 'terminal_attested',
    });
    expect(stored(id).assuranceShortfall).toBeUndefined();
    expect(evaluateApprovalUsability(stored(id))).toBeNull();
  });

  it('with SoD on, an owner request opened with --requested-by agent:x is still a self-approval', async () => {
    setSeparationOfDuties(true);
    // What a CLI entry point does with `--requested-by agent:x` from the owner's terminal.
    const invoker: AttestationInvoker = {
      ...captureAttestationInvoker(),
      approvalRequester: resolveCliApprovalRequester({ explicit: 'agent:x', legacy: 'operator' }),
    };
    const id = requestFromCli({}, invoker);
    expect(stored(id)).toMatchObject({
      requestedBy: 'agent:x',
      requestedByContext: expect.objectContaining({ actorId: 'user:owner' }),
    });
    await expect(approveAtTty(id)).rejects.toThrow(
      /Separation of duties: approval refused because the decider is the same principal/
    );
  });

  it('with SoD off, an agent session still cannot decide a human-only request from the terminal', async () => {
    vi.stubEnv('KYBERION_AGENT_ID', 'planner');
    const id = requestFromCli();
    expect(stored(id).accountability?.finalDecision).toBe('human_only');
    await expect(approveFromCli(id)).rejects.toThrow(/\[APPROVAL_HUMAN_PROOF_REQUIRED\]/);
    expect(stored(id).status).toBe('pending');
  });

  it('with SoD on, refuses to approve from inside an agent session', async () => {
    setSeparationOfDuties(true);
    vi.stubEnv('KYBERION_AGENT_ID', 'planner');
    const id = requestFromCli();
    expect(stored(id).requestedBy).toBe('agent:planner');

    vi.stubEnv('KYBERION_AGENT_ID', 'reviewer');
    await expect(approveFromCli(id)).rejects.toThrow(
      /^\[APPROVAL_HUMAN_PROOF_REQUIRED\] approval decision blocked — this command runs inside an agent session \(agent:reviewer\) and the request is human-only/
    );
    expect(stored(id).status).toBe('pending');
  });

  it('with SoD on and no owner member, reports the missing identity instead of using a placeholder', async () => {
    setSeparationOfDuties(true);
    vi.stubEnv('CLAUDECODE', '1');
    const id = requestFromCli();
    plainTerminal();
    identity.ownerPresent = false;

    await expect(approveFromCli(id)).rejects.toThrow(
      /approval decision blocked — separation of duties is on and this terminal has no stable operator identity.*pnpm organization member ensure-owner/
    );
    expect(stored(id).status).toBe('pending');
    // Opening a new request (a different claim) is refused the same way.
    expect(() => requestFromCli({ plan: 'ChatGPT Team' })).toThrow(
      /approval request blocked — .*no stable operator identity.*pnpm organization member ensure-owner/
    );
  });

  it('with SoD off and no owner member, keeps the previous records (persona requester, display-name decider)', async () => {
    identity.ownerPresent = false;
    const id = requestFromCli();
    expect(stored(id).requestedBy).not.toMatch(/^(user|agent):/);

    await decideFromCliAtTty(id);
    expect(stored(id)).toMatchObject({ status: 'approved', decidedBy: 'Alice Example' });
  });

  it('revokes an approved, unused approval from the terminal so no consumer can use it', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    const id = requestFromCli();
    plainTerminal();
    await decideFromCliAtTty(id);

    const output: unknown[] = [];
    await kyberionHome(['approvals', '--revoke', id, '--reason', 'approved the wrong plan'], (v) =>
      output.push(v)
    );
    expect(String(output.at(-1))).toContain(`${id} → revoked`);
    expect(stored(id)).toMatchObject({
      status: 'approved',
      revocation: {
        revokedBy: 'user:owner',
        revokedByDisplayName: 'Alice Example',
        reason: 'approved the wrong plan',
      },
    });

    // The attestation consumer refuses it (separation of duties is off).
    expect(() =>
      withExecutionContext('sovereign_concierge', () =>
        attestTenantProvider({
          ...claim,
          rootDir,
          invoker: { actor: 'operator-cli' },
          approvalRequestId: id,
        })
      )
    ).toThrow(/cannot be used because it was revoked by user:owner/);
    // Re-requesting opens a fresh request instead of handing back the revoked one.
    vi.stubEnv('CLAUDECODE', '1');
    expect(requestFromCli()).not.toBe(id);

    // A revoked (or unknown) id is no longer revocable.
    plainTerminal();
    await expect(kyberionHome(['approvals', '--revoke', id])).rejects.toThrow();
  });

  it('with SoD off, an operator still approves their own CLI request (now recorded as user:owner)', async () => {
    const id = requestFromCli();
    await decideFromCliAtTty(id);
    expect(stored(id)).toMatchObject({
      status: 'approved',
      requestedBy: 'user:owner',
      decidedBy: 'user:owner',
    });
  });

  describe('terminal attestation for human-only requests (HA-04)', () => {
    it('refuses a non-interactive approve or reject, whatever the separation-of-duties setting', async () => {
      const id = requestFromCli();
      await expect(approveFromCli(id)).rejects.toThrow(
        /^\[APPROVAL_HUMAN_PROOF_REQUIRED\].*not interactive/
      );
      await expect(kyberionHome(['approvals', '--deny', id])).rejects.toThrow(
        /^\[APPROVAL_HUMAN_PROOF_REQUIRED\].*not interactive/
      );
      expect(stored(id).status).toBe('pending');
    });

    it('records terminal_attested and the terminal evidence in the audit trail', async () => {
      const audit = vi.spyOn(auditChain, 'record');
      useTerminalEvidence({
        osUser: 'alice',
        tty: 'ttys003',
        lineage: [
          { pid: 4100, command: '-zsh' },
          {
            pid: 4000,
            command: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
          },
        ],
      });
      const id = requestFromCli();
      await decideFromCliAtTty(id, '--deny');
      expect(stored(id)).toMatchObject({
        status: 'rejected',
        decidedBy: 'user:owner',
        decidedAuthMethod: 'terminal_attested',
        decidedVia: 'cli_tty_challenge',
      });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'terminal_attested',
          metadata: expect.objectContaining({
            requestId: id,
            operatorId: 'user:owner',
            osUser: 'alice',
            tty: 'ttys003',
            parentLineage: expect.arrayContaining([expect.objectContaining({ command: '-zsh' })]),
            presentedDigest: computeApprovalPresentedDigest(stored(id)),
          }),
        })
      );
      audit.mockRestore();
    });

    it('refuses when a provider CLI is among the parent processes, before prompting', async () => {
      useTerminalEvidence({
        osUser: 'alice',
        tty: 'ttys003',
        lineage: [
          { pid: 4100, command: '/bin/zsh' },
          { pid: 4000, command: '/Users/alice/.local/bin/claude' },
        ],
      });
      const id = requestFromCli();
      let prompted = false;
      await expect(
        withTtyAnswer(
          (code) => {
            prompted = true;
            return code;
          },
          () => decideApprovalFromCli(stored(id), { decision: 'approved', note: 'lineage' })
        )
      ).rejects.toThrow(/^\[APPROVAL_HUMAN_PROOF_REQUIRED\].*provider CLI \(claude-cli\)/);
      expect(prompted).toBe(false);
      expect(stored(id).status).toBe('pending');
    });

    it('probes the real process tree when no test evidence is installed, even under VITEST', async () => {
      expect(process.env.VITEST).toBeTruthy();
      // The direct parent is a node-wrapped provider CLI, as `ps -o command=` prints it.
      psTree.parents = new Map([
        [-1, [4242, '/bin/zsh -c pnpm kyberion approvals --approve']],
        [4242, [4100, 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js exec']],
        [4100, [1, '-zsh']],
      ]);
      useTerminalEvidence('probe');
      const id = requestFromCli();
      let prompted = false;
      try {
        await expect(
          withTtyAnswer(
            (code) => {
              prompted = true;
              return code;
            },
            () => decideApprovalFromCli(stored(id), { decision: 'approved', note: 'probe' })
          )
        ).rejects.toThrow(/^\[APPROVAL_HUMAN_PROOF_REQUIRED\].*provider CLI \(codex-cli\)/);
      } finally {
        psTree.parents = null;
      }
      expect(prompted).toBe(false);
      expect(stored(id).status).toBe('pending');
    });

    it("an explicit 'probe' discards evidence a test installed earlier", async () => {
      psTree.parents = new Map([
        [-1, [4242, '/bin/zsh']],
        [4242, [1, 'node /Users/a/.npm/_npx/6f1c2a/node_modules/@anthropic-ai/claude-code/cli.js']],
      ]);
      useTerminalEvidence({ osUser: 'alice', tty: 'ttys003', lineage: [] });
      const id = requestFromCli();
      try {
        await expect(
          withTtyAnswer(
            (code) => code,
            () => decideApprovalFromCli(stored(id), { decision: 'approved', note: 'probe' }),
            { evidence: 'probe' }
          )
        ).rejects.toThrow(/^\[APPROVAL_HUMAN_PROOF_REQUIRED\].*provider CLI \(claude-cli\)/);
      } finally {
        psTree.parents = null;
      }
      expect(stored(id).status).toBe('pending');
    });

    it('walks the whole process tree, not just the nearest dozen ancestors', async () => {
      // 30 nested shells between this command and the provider CLI.
      const parents = new Map<number, [number, string]>([[-1, [5000, '/bin/zsh']]]);
      for (let pid = 5000; pid < 5030; pid += 1) parents.set(pid, [pid + 1, '/bin/zsh -l']);
      parents.set(5030, [1, '/Users/alice/.local/bin/cursor-agent']);
      psTree.parents = parents;
      useTerminalEvidence('probe');
      const id = requestFromCli();
      try {
        await expect(
          withTtyAnswer(
            (code) => code,
            () => decideApprovalFromCli(stored(id), { decision: 'approved', note: 'deep' })
          )
        ).rejects.toThrow(/^\[APPROVAL_HUMAN_PROOF_REQUIRED\].*provider CLI \(cursor-cli\)/);
      } finally {
        psTree.parents = null;
      }
      expect(stored(id).status).toBe('pending');
    });

    it('binds the code to what was shown: a decision on a stale view is refused by the store', async () => {
      const id = requestFromCli();
      await expect(
        withTtyAnswer(
          (code) => code,
          () =>
            decideApprovalFromCli(
              { ...stored(id), title: 'what the terminal showed earlier' },
              { decision: 'approved', note: 'stale' }
            )
        )
      ).rejects.toThrow(/changed since it was shown to the decider/);
      expect(stored(id).status).toBe('pending');
    });
  });
});
