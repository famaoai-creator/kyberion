import { describe, expect, it } from 'vitest';
import {
  isPipelineJournalCapability,
  pipelineJournalCapability,
  withPipelineJournalCapability,
} from './pipeline-journal-capability.js';
import {
  createSynchronousResourceGrantIssuer,
  currentResourceAccessScope,
  runInResourceAccessScope,
} from './resource-access-scope.js';

const TENANT = 'tenant-a';
const FILE = 'active/shared/runtime/pipeline-library-runs/confidential/' + TENANT + '/run.jsonl';
const live = () => isPipelineJournalCapability(currentResourceAccessScope());

describe('pipeline journal grant (G2: module-private, unforgeable)', () => {
  it('resolves only the live grant of its own issuer, read or write', () => {
    expect(withPipelineJournalCapability(TENANT, FILE, true, live)).toBe(true);
    expect(withPipelineJournalCapability(TENANT, FILE, false, live)).toBe(true);
    expect(
      withPipelineJournalCapability(
        TENANT,
        FILE,
        false,
        () => currentResourceAccessScope()!.writeExact.length
      )
    ).toBe(0);
    expect(live()).toBe(false);
  });

  it('refuses a structural lookalike, a copy and a counterfeit issuer', () => {
    expect(runInResourceAccessScope(pipelineJournalCapability(TENANT, FILE), live)).toBe(false);
    withPipelineJournalCapability(TENANT, FILE, true, () => {
      const issued = currentResourceAccessScope()!;
      expect(isPipelineJournalCapability({ ...issued })).toBe(false);
      expect(runInResourceAccessScope({ ...issued }, live)).toBe(false);
    });
    const counterfeit = createSynchronousResourceGrantIssuer<object>('PIPELINE_JOURNAL_CAPABILITY');
    expect(counterfeit.run({}, pipelineJournalCapability(TENANT, FILE), live)).toBe(false);
  });

  it('refuses a journal outside the tenant partition', () => {
    expect(() =>
      withPipelineJournalCapability(
        TENANT,
        `knowledge/confidential/${TENANT}/run.jsonl`,
        true,
        live
      )
    ).toThrow('RESOURCE_SCOPE_INVALID');
    expect(() =>
      withPipelineJournalCapability(
        TENANT,
        'active/shared/runtime/pipeline-library-runs/confidential/other/run.jsonl',
        true,
        live
      )
    ).toThrow('RESOURCE_SCOPE_INVALID');
  });

  it('is synchronous: no escape, no thenable, no captured continuation', async () => {
    expect(() =>
      withPipelineJournalCapability(TENANT, FILE, true, () => currentResourceAccessScope())
    ).toThrow('PIPELINE_JOURNAL_CAPABILITY_ESCAPE');
    expect(() =>
      withPipelineJournalCapability(TENANT, FILE, true, () => Promise.resolve(true))
    ).toThrow('PIPELINE_JOURNAL_CAPABILITY_ASYNC');
    let later: Promise<boolean> | undefined;
    withPipelineJournalCapability(TENANT, FILE, true, () => {
      later = new Promise((resolve) => setTimeout(() => resolve(live()), 0));
    });
    await expect(later).resolves.toBe(false);
  });
});
