/**
 * MP-05: the `lock_media_brief` op and the run-shape it carries.
 *
 * The point of locking is that the decisions become visible and binding: what
 * the operator stated, what was inferred for them, and what the run is allowed
 * to do. A run-shape that downstream steps ignore would be decoration.
 */
import { describe, expect, it } from 'vitest';
import { pathResolver, safeMkdir, safeWriteFile } from '@agent/core';
import path from 'node:path';
import { handleAction } from './index.js';

async function runSteps(context: Record<string, unknown>, steps: unknown[]): Promise<any> {
  const result = await handleAction({ action: 'pipeline', context, steps } as any);
  expect(result.status).toBe('succeeded');
  return result.context;
}

async function lockBrief(brief: Record<string, unknown>, params: Record<string, unknown> = {}) {
  const ctx = await runSteps({ last_json: brief }, [
    { type: 'transform', op: 'lock_media_brief', params: { from: 'last_json', ...params } },
  ]);
  return ctx.locked_media_brief;
}

describe('lock_media_brief', () => {
  it('records stated fields as stated', async () => {
    const locked = await lockBrief({
      title: '導入提案',
      audience: '経営層',
      tone: 'formal',
      locale: 'ja-JP',
    });
    const byField = Object.fromEntries(locked.decisions.map((d: any) => [d.field, d]));
    expect(byField.audience.provenance).toBe('stated');
    expect(byField.tone.provenance).toBe('stated');
    expect(byField.locale.provenance).toBe('stated');
  });

  it('marks filled-in gaps as inferred, with a reason', async () => {
    const locked = await lockBrief({ title: '導入提案', audience: '経営層' });
    const tone = locked.decisions.find((d: any) => d.field === 'tone');
    expect(tone.provenance).toBe('inferred');
    expect(tone.rationale).toContain('経営層');
  });

  it('never lets an inference override a stated value', async () => {
    const locked = await lockBrief({ title: 'x', audience: '経営層', tone: 'casual' });
    const tone = locked.decisions.filter((d: any) => d.field === 'tone');
    expect(tone).toHaveLength(1);
    expect(tone[0].value).toBe('casual');
    expect(tone[0].provenance).toBe('stated');
  });

  it('defaults to withholding external egress and degraded fallback', async () => {
    const locked = await lockBrief({ title: 'x' });
    expect(locked.run_shape.allow_external_visual_review).toBe(false);
    expect(locked.run_shape.allow_degraded_fallback).toBe(false);
  });

  it('accepts an explicit run-shape', async () => {
    const locked = await lockBrief(
      { title: 'x' },
      { run_shape: { visual_review_rounds: 0, allow_external_visual_review: true } }
    );
    expect(locked.run_shape.visual_review_rounds).toBe(0);
    expect(locked.run_shape.allow_external_visual_review).toBe(true);
  });

  it('fails the step when the brief is missing', async () => {
    const result: any = await handleAction({
      action: 'pipeline',
      context: {},
      steps: [{ type: 'transform', op: 'lock_media_brief', params: { from: 'nope' } }],
    } as any);
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).toContain('UNKNOWN_INPUT');
  });
});

describe('run-shape governs the visual review', () => {
  const TMP = pathResolver.sharedTmp('brief-lock-op-tests');

  function fixture(name: string): string {
    safeMkdir(TMP, { recursive: true });
    const filePath = path.join(TMP, name);
    safeWriteFile(filePath, 'placeholder deck');
    return filePath;
  }

  it('skips the review when the brief disables it, and says why', async () => {
    // A disabled review is a deliberate skip, not a pass.
    const ctx = await runSteps({ last_json: { title: 'x' } }, [
      {
        type: 'transform',
        op: 'lock_media_brief',
        params: { from: 'last_json', run_shape: { visual_review_rounds: 0 } },
      },
      {
        type: 'transform',
        op: 'visual_review',
        params: { path: fixture('deck.pptx'), export_as: 'review' },
      },
    ]);

    expect(ctx.review.status).toBe('skipped');
    expect(ctx.review.skipped_reason).toContain('disabled by the locked brief');
    expect(ctx.review.findings).toEqual([]);
  });

  it('runs the review when the brief enables it', async () => {
    const ctx = await runSteps({ last_json: { title: 'x' } }, [
      {
        type: 'transform',
        op: 'lock_media_brief',
        params: { from: 'last_json', run_shape: { visual_review_rounds: 2 } },
      },
      {
        type: 'transform',
        op: 'visual_review',
        params: { path: fixture('deck2.pptx'), export_as: 'review' },
      },
    ]);

    // It still skips here (no vision channel on this host), but for a
    // different, honest reason than "the operator turned it off".
    expect(ctx.review.skipped_reason).not.toContain('disabled by the locked brief');
  });
});
