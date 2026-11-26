import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
vi.mock('../authn/stance-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../authn/stance-resolver.js')>();
  const { customerRootWithSodOverlay } =
    await import('../governance/__tests__/sod-overlay-state.js');
  return { ...actual, stanceRoot: customerRootWithSodOverlay(actual.stanceRoot) };
});
import {
  clearSeparationOfDuties,
  setSeparationOfDuties,
  useSeparationOfDutiesOverlay,
} from '../governance/__tests__/sod-overlay.js';

import {
  approvalRequestLogicalPath,
  decideApprovalRequest,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
  safeUnlinkSync,
  withExecutionContext,
} from '../index.js';
import { safeMkdir } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertProjectTrustApproval,
  createProjectTrustApprovalRequest,
  findValidRunManifestTrustApproval,
  parseDelegatedTrustScope,
  projectTrustBindingOf,
  PROJECT_TRUST_APPROVAL_CHANNEL,
  requestPipelineTrustWithManifest,
} from './project-trust.js';
import {
  computeApprovalPayloadHash,
  computeApprovalPresentedDigest,
} from '../governance/approval-presentation.js';
import {
  compileRunManifest,
  computeRunManifestHash,
  type RunManifest,
} from '../pipeline/run-manifest.js';

// Per-test overlay file for switching separation of duties on/off.
useSeparationOfDutiesOverlay(
  pathResolver.sharedTmp(`sod-overlay-project-trust-${process.pid}.json`)
);

describe('project trust approvals', () => {
  it('re-request opens a new request instead of reusing a self-approval that separation of duties makes unusable', () => {
    const inputPath = pathResolver.sharedTmp(`project-trust-sod-${process.pid}-${Date.now()}.json`);
    safeWriteFile(inputPath, JSON.stringify({ pipeline_id: 'project-trust-sod', steps: [] }));
    const ids: string[] = [];
    try {
      setSeparationOfDuties(false);
      const first = createProjectTrustApprovalRequest({ inputPath, requestedBy: 'trust-operator' });
      ids.push(first.id);
      decideApprovalRequest('mission_controller', {
        channel: first.channel,
        storageChannel: first.storageChannel,
        requestId: first.id,
        decision: 'approved',
        decidedBy: 'trust-operator',
        decidedByRole: 'sovereign',
        authMethod: 'manual',
        decidedByType: 'human',
        authenticated: true,
        payloadHash: first.accountability?.payloadHash,
        effectBinding: first.accountability?.effectBinding,
      });
      expect(
        createProjectTrustApprovalRequest({ inputPath, requestedBy: 'trust-operator' }).id
      ).toBe(first.id);
      setSeparationOfDuties(true);
      expect(() => assertProjectTrustApproval(first.id, inputPath)).toThrow(/Separation of duties/);
      const second = createProjectTrustApprovalRequest({
        inputPath,
        requestedBy: 'trust-operator',
      });
      ids.push(second.id);
      expect(second.id).not.toBe(first.id);
    } finally {
      clearSeparationOfDuties();
      withExecutionContext('mission_controller', () => {
        for (const id of ids) {
          safeRmSync(
            pathResolver.rootResolve(
              approvalRequestLogicalPath(PROJECT_TRUST_APPROVAL_CHANNEL, id)
            ),
            { force: true }
          );
        }
        safeRmSync(inputPath, { force: true });
      });
    }
  });

  it('requires an approved human decision and rejects content drift', () => {
    const inputPath = pathResolver.sharedTmp(`project-trust-${process.pid}-${Date.now()}.json`);
    safeWriteFile(
      inputPath,
      JSON.stringify({ pipeline_id: 'project-trust-test', steps: [{ op: 'core:if' }] })
    );
    let requestId = '';
    try {
      const request = createProjectTrustApprovalRequest({
        inputPath,
        requestedBy: 'test-operator',
      });
      requestId = request.id;
      expect(() => assertProjectTrustApproval(request.id, inputPath)).toThrow(
        '[TRUST_REQUIRED] project-trust request'
      );

      const decided = decideApprovalRequest('mission_controller', {
        channel: request.channel,
        storageChannel: request.storageChannel,
        requestId: request.id,
        decision: 'approved',
        decidedBy: 'human-operator',
        decidedByRole: 'sovereign',
        authMethod: 'manual',
        decidedByType: 'human',
        authenticated: true,
        payloadHash: request.accountability?.payloadHash,
        effectBinding: request.accountability?.effectBinding,
      });
      expect(decided.decidedByType).toBe('human');
      expect(decided.authenticated).toBe(true);
      expect(() => assertProjectTrustApproval(request.id, inputPath)).not.toThrow();

      safeWriteFile(inputPath, JSON.stringify({ pipeline_id: 'changed', steps: [] }));
      expect(() => assertProjectTrustApproval(request.id, inputPath)).toThrow(
        'project-local pipeline changed after approval'
      );
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(inputPath, { force: true });
        if (requestId) {
          safeRmSync(approvalRequestLogicalPath(PROJECT_TRUST_APPROVAL_CHANNEL, requestId), {
            force: true,
          });
        }
      });
    }
  });

  it('does not create an approval request for repository-owned pipelines', () => {
    expect(() =>
      createProjectTrustApprovalRequest({ inputPath: 'pipelines/baseline-check.json' })
    ).toThrow('[PROJECT_TRUST_NOT_REQUIRED]');
  });

  it('rejects a pipeline path that traverses a symbolic link', () => {
    const targetPath = pathResolver.sharedTmp(`project-trust-target-${process.pid}.json`);
    const linkPath = pathResolver.sharedTmp(`project-trust-link-${process.pid}.json`);
    safeWriteFile(targetPath, JSON.stringify({ pipeline_id: 'symlink-target', steps: [] }));
    safeSymlinkSync(targetPath, linkPath);
    try {
      expect(() => createProjectTrustApprovalRequest({ inputPath: linkPath })).toThrow(
        'cannot traverse a symbolic link'
      );
    } finally {
      withExecutionContext('mission_controller', () => {
        safeUnlinkSync(linkPath);
        safeRmSync(targetPath, { force: true });
      });
    }
  });

  it('rejects a pipeline path replaced with a directory', () => {
    const directoryPath = pathResolver.sharedTmp(
      `project-trust-directory-${process.pid}-${Date.now()}.json`
    );
    safeMkdir(directoryPath, { recursive: true });
    try {
      expect(() => createProjectTrustApprovalRequest({ inputPath: directoryPath })).toThrow(
        'pipeline resource must be a regular file'
      );
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(directoryPath, { recursive: true, force: true });
      });
    }
  });
});

describe('project trust v2 (run manifest)', () => {
  const STEPS = [
    { op: 'secret:get', params: { service: 'garoon', account: 'user', export_as: 'pw' } },
    { op: 'browser:goto', params: { url: 'https://g.example.com/x' } },
    { op: 'browser:fill', params: { selector: '#password', text: '{{pw}}' } },
    { op: 'browser:goto', params: { url: 'https://{{host}}/y' } },
  ];

  function writePipeline(): { inputPath: string; relative: string; manifest: RunManifest } {
    const inputPath = pathResolver.sharedTmp(
      `project-trust-v2-${process.pid}-${randomUUID()}.json`
    );
    const text = JSON.stringify({ pipeline_id: 'project-trust-v2', steps: STEPS });
    safeWriteFile(inputPath, text);
    const relative = path.relative(pathResolver.rootDir(), inputPath).replaceAll('\\', '/');
    const manifest = compileRunManifest(STEPS, {
      inputPath: relative,
      contentSha256: createHash('sha256').update(text).digest('hex'),
      scope: { tier: 'confidential', tenantSlug: 'acme' },
    });
    return { inputPath, relative, manifest };
  }

  function cleanup(inputPath: string, ids: string[]) {
    withExecutionContext('mission_controller', () => {
      for (const id of ids) {
        safeRmSync(
          pathResolver.rootResolve(approvalRequestLogicalPath(PROJECT_TRUST_APPROVAL_CHANNEL, id)),
          { force: true }
        );
      }
      safeRmSync(inputPath, { force: true });
    });
  }

  it('shows the manifest in plain language with one hash footer, bound by the presented digest', () => {
    const { inputPath, relative, manifest } = writePipeline();
    const ids: string[] = [];
    try {
      const request = requestPipelineTrustWithManifest({
        inputPath,
        manifest,
        // A caller cannot choose the selectors the card names: they come from
        // the file content the manifest binds, so this forged list is ignored.
        steps: [
          STEPS[0],
          STEPS[1],
          { op: 'browser:fill', params: { selector: '#harmless-search-box' } },
        ],
        requestedBy: 'trust-operator',
      } as Parameters<typeof requestPipelineTrustWithManifest>[0]);
      ids.push(request.id);
      const lines = String(request.details).split('\n');
      expect(lines[0]).toBe(`Path: ${relative}`);
      expect(lines).toContain('Who may run it: you at the terminal only');
      expect(lines).toContain(
        'How often: at most 20 runs per day (UTC); later runs that day ask step by step'
      );
      expect(lines).toContain('Secrets: garoon/user');
      expect(lines).toContain('Open https://g.example.com/x once');
      expect(lines).toContain('Type secret garoon/user into #password on g.example.com once');
      expect(String(request.details)).not.toContain('#harmless-search-box');
      expect(lines).toContain(
        'Will still ask per step: browser:goto at step 3 — the site address is decided at run time'
      );
      expect(lines.filter((line) => line.includes('SHA-256'))).toEqual([
        `Binding: content SHA-256 ${manifest.source.content_sha256} · manifest SHA-256 ${manifest.manifest_hash}`,
      ]);
      expect(lines.at(-1)).toMatch(/^Binding: /);
      expect(request.summary).toContain('Only you, at the terminal');
      expect(projectTrustBindingOf(request)).toEqual({
        version: 2,
        manifest_hash: manifest.manifest_hash,
        principal_modes: ['attended'],
        runs_per_day: 20,
      });
      expect(request.accountability?.payloadHash).toBe(
        computeApprovalPayloadHash({
          version: 2,
          input_path: relative,
          content_hash: manifest.source.content_sha256,
          manifest_hash: manifest.manifest_hash,
          principal_modes: ['attended'],
          runs_per_day: 20,
        })
      );
      // The manifest lines are part of what the presented digest covers.
      expect(computeApprovalPresentedDigest(request)).not.toBe(
        computeApprovalPresentedDigest({
          ...request,
          details: String(request.details).replace('#password', '#other'),
        })
      );

      const decided = decideApprovalRequest('mission_controller', {
        channel: request.channel,
        storageChannel: request.storageChannel,
        requestId: request.id,
        decision: 'approved',
        decidedBy: 'human-operator',
        decidedByRole: 'sovereign',
        authMethod: 'manual',
        decidedByType: 'human',
        authenticated: true,
        presentedDigest: computeApprovalPresentedDigest(request),
      });
      expect(decided.verifiedPresentedDigest).toBe(computeApprovalPresentedDigest(request));
      // A v2 approval is still a valid trust decision for the file.
      expect(() => assertProjectTrustApproval(request.id, inputPath)).not.toThrow();
      expect(findValidRunManifestTrustApproval(inputPath, manifest.manifest_hash)).toBe(request.id);
      expect(findValidRunManifestTrustApproval(inputPath, 'd'.repeat(64))).toBeNull();

      safeWriteFile(inputPath, JSON.stringify({ pipeline_id: 'changed', steps: [] }));
      expect(() => assertProjectTrustApproval(request.id, inputPath)).toThrow(
        'project-local pipeline changed after approval'
      );
      expect(findValidRunManifestTrustApproval(inputPath, manifest.manifest_hash)).toBeNull();
    } finally {
      cleanup(inputPath, ids);
    }
  });

  it('keeps v1 and v2 requests apart and makes unattended runs explicit', () => {
    const { inputPath, manifest } = writePipeline();
    const ids: string[] = [];
    try {
      const v1 = createProjectTrustApprovalRequest({ inputPath, requestedBy: 'trust-operator' });
      ids.push(v1.id);
      expect(projectTrustBindingOf(v1)).toEqual({ version: 1 });
      expect(v1.details).toContain('Content SHA-256');
      const attended = requestPipelineTrustWithManifest({ inputPath, manifest });
      ids.push(attended.id);
      const unattended = requestPipelineTrustWithManifest({
        inputPath,
        manifest,
        principalModes: ['unattended', 'attended'],
      });
      ids.push(unattended.id);
      expect(new Set([v1.id, attended.id, unattended.id]).size).toBe(3);
      expect(unattended.summary).toContain('UNATTENDED RUNS ENABLED');
      expect(unattended.details).toContain(
        'Who may run it: you at the terminal, AND unattended workers without you'
      );
      expect(projectTrustBindingOf(unattended)).toMatchObject({
        principal_modes: ['attended', 'unattended'],
      });
      // Re-requesting the same binding reuses the pending request.
      expect(requestPipelineTrustWithManifest({ inputPath, manifest }).id).toBe(attended.id);
    } finally {
      cleanup(inputPath, ids);
    }
  });

  it('binds the daily run cap into the payload and the presented card', () => {
    const { inputPath, manifest } = writePipeline();
    const ids: string[] = [];
    try {
      const byDefault = requestPipelineTrustWithManifest({ inputPath, manifest });
      ids.push(byDefault.id);
      const one = requestPipelineTrustWithManifest({ inputPath, manifest, runsPerDay: 1 });
      ids.push(one.id);
      const five = requestPipelineTrustWithManifest({ inputPath, manifest, runsPerDay: 5 });
      ids.push(five.id);
      expect(new Set(ids).size).toBe(3);
      expect(one.details).toContain('How often: at most 1 run per day (UTC)');
      expect(five.details).toContain('How often: at most 5 runs per day (UTC)');
      expect(projectTrustBindingOf(five)).toMatchObject({ runs_per_day: 5 });
      expect(five.justification?.requestedEffects).toContain('run-runs-per-day:5');
      expect(five.accountability?.payloadHash).not.toBe(one.accountability?.payloadHash);
      expect(computeApprovalPresentedDigest(five)).not.toBe(computeApprovalPresentedDigest(one));
      // Same card text, other bound cap: the digest still differs (requestedEffects).
      expect(computeApprovalPresentedDigest(five)).not.toBe(
        computeApprovalPresentedDigest({
          ...five,
          justification: {
            ...five.justification!,
            requestedEffects: five.justification!.requestedEffects!.map((effect) =>
              effect === 'run-runs-per-day:5' ? 'run-runs-per-day:500' : effect
            ),
          },
        })
      );
      for (const bad of [0, -1, 1.5, 1001])
        expect(() =>
          requestPipelineTrustWithManifest({ inputPath, manifest, runsPerDay: bad })
        ).toThrow('[PROJECT_TRUST_RUN_LIMIT]');
      expect(() => createProjectTrustApprovalRequest({ inputPath, runsPerDay: 3 })).toThrow(
        '[PROJECT_TRUST_RUN_LIMIT]'
      );
    } finally {
      cleanup(inputPath, ids);
    }
  });

  it('reads a v2 record from before the daily cap as uncapped-by-field (default applies later)', () => {
    const legacy = {
      justification: {
        reason: 'trust',
        requestedEffects: [
          'project-trust:x.json',
          `run-manifest:${'a'.repeat(64)}`,
          'run-principals:attended',
        ],
      },
    };
    expect(projectTrustBindingOf(legacy)).toEqual({
      version: 2,
      manifest_hash: 'a'.repeat(64),
      principal_modes: ['attended'],
    });
    const twoCaps = structuredClone(legacy);
    twoCaps.justification.requestedEffects.push('run-runs-per-day:1', 'run-runs-per-day:2');
    expect(projectTrustBindingOf(twoCaps)).toMatchObject({ version: 'invalid' });
    const badCap = structuredClone(legacy);
    badCap.justification.requestedEffects.push('run-runs-per-day:0');
    expect(projectTrustBindingOf(badCap)).toMatchObject({ version: 'invalid' });
  });

  it('refuses a manifest that does not describe the current file', () => {
    const { inputPath, manifest } = writePipeline();
    try {
      const other = { ...manifest, source: { ...manifest.source, content_sha256: 'e'.repeat(64) } };
      expect(() =>
        requestPipelineTrustWithManifest({
          inputPath,
          manifest: { ...other, manifest_hash: computeRunManifestHash(other) },
        })
      ).toThrow('[PROJECT_TRUST_MANIFEST]');
      expect(() =>
        requestPipelineTrustWithManifest({
          inputPath,
          manifest: { ...manifest, complete: !manifest.complete },
        })
      ).toThrow('does not match its body');
      expect(() =>
        createProjectTrustApprovalRequest({ inputPath, principalModes: ['unattended'] })
      ).toThrow('[PROJECT_TRUST_PRINCIPAL]');
    } finally {
      cleanup(inputPath, []);
    }
  });
});

describe('parseDelegatedTrustScope', () => {
  it('maps the flag spellings to charter scopes', () => {
    expect(parseDelegatedTrustScope('person')).toEqual({ kind: 'person' });
    expect(parseDelegatedTrustScope(true)).toEqual({ kind: 'person' });
    expect(parseDelegatedTrustScope('')).toEqual({ kind: 'person' });
    expect(parseDelegatedTrustScope('tenant:acme')).toEqual({
      kind: 'organization',
      tenant_slug: 'acme',
    });
  });

  it('rejects unknown scope spellings', () => {
    for (const bad of ['acme', 'org:acme', 'tenant:', 42]) {
      expect(() => parseDelegatedTrustScope(bad)).toThrow('DELEGATED_TRUST_SCOPE');
    }
  });
});

describe('evaluateProjectTrustDelegation', () => {
  const NOW = new Date('2026-10-31T09:00:00.000Z');
  let root = '';

  afterAll(() => {
    if (root) safeRmSync(root, { recursive: true, force: true });
  });

  it('lets a charter delegating pipeline_trust_grant stand in for approval', async () => {
    const { acceptCharter } = await import('../governance/accountability-charter-registry.js');
    const { humanActor } = await import('../contracts/actor.js');
    const { evaluateProjectTrustDelegation } = await import('./project-trust.js');
    const { safeWriteFile } = await import('../secure-io.js');
    root = pathResolver.sharedTmp(`pt-delegation-${randomUUID()}`);
    acceptCharter(
      {
        draft: {
          charter_id: 'chr-trust-1',
          scope: { kind: 'organization', tenant_slug: 'acme' },
          accountable: {
            actor: 'user:owner',
            authority_basis: { kind: 'officer', evidence_ref: 'registry-extract' },
            expires_at: '2026-12-31T00:00:00.000Z',
            deputies: [],
          },
          envelope: {
            money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 },
            data_tier: { read: [], write: [] },
            external_effects: {},
            irreversible: 'named_actions_only',
            irreversible_named_actions: [],
            delegated_decisions: { pipeline_trust_grant: 'allow' },
          },
          appetite: {
            max_loss_per_incident: 0,
            reputational_class_max: 'B',
            blast_radius_max: { recipients: 0, systems: 1 },
            tripwires: [],
          },
        },
        statement: 'I am accountable.',
        acceptedBy: humanActor('owner'),
        validation: { holder_role: 'owner' },
        now: NOW,
      },
      { rootDir: root }
    );
    const adfPath = pathResolver.sharedTmp(`pt-delegation-adf-${randomUUID()}.json`);
    safeWriteFile(adfPath, JSON.stringify({ action: 'pipeline', steps: [] }));
    const result = evaluateProjectTrustDelegation({
      inputPath: adfPath,
      scope: { kind: 'organization', tenant_slug: 'acme' },
      agentId: 'pipeline-cli',
      now: NOW,
      pathOptions: { rootDir: root },
    });
    expect(result).toMatchObject({ delegated: true, charterId: 'chr-trust-1' });
    // A scope whose charter does not name the decision type falls back closed.
    expect(
      evaluateProjectTrustDelegation({
        inputPath: adfPath,
        scope: { kind: 'organization', tenant_slug: 'other' },
        agentId: 'pipeline-cli',
        now: NOW,
        pathOptions: { rootDir: root },
      })
    ).toMatchObject({ delegated: false });
    safeRmSync(adfPath, { force: true });
  });
});
