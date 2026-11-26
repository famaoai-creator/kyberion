import { afterEach, describe, expect, it } from 'vitest';
import { registerScenarioOpOverride } from '@agent/core/actuator/actuator-op-registry';
import { computeApprovalPayloadHash } from '@agent/core/governance/approval-presentation';
import {
  currentRunManifestBinding,
  currentRunManifestStep,
  withoutRunManifestBinding,
  withRunManifestBinding,
  withRunManifestStep,
} from '@agent/core/governance/external-operation-runtime';
import { prepareEngineSteps, withManifestStep } from './pipeline-execution-part-control.js';
import { compileRunManifest } from '@agent/core/pipeline/run-manifest';

// Load through the same specifier the pipeline entry uses so the test shares
// one instance of the engine module graph.
const { runValidatedSteps } = await import(new URL('../run_pipeline.js', import.meta.url).href);

/** Every nested body shape the compiler assigns entry ids to. */
const STEPS = [
  { id: 'open', op: 'browser:goto', params: { url: 'https://app.example.test/login' } },
  {
    id: 'branch',
    op: 'core:if',
    params: {
      condition: { from: 'flag', operator: 'eq', value: true },
      then: [{ id: 'title', op: 'browser:evaluate', params: { script: 'document.title' } }],
      else: [{ id: 'never', op: 'browser:click', params: { selector: '#never' } }],
    },
  },
  {
    id: 'poll',
    op: 'core:while',
    params: {
      condition: { from: 'flag', operator: 'eq', value: true },
      max_iterations: 2,
      pipeline: [
        {
          id: 'probe',
          op: 'browser:evaluate',
          params: { script: '(a) => a.x', args: { x: '{{flag}}' }, export_as: 'probe' },
        },
      ],
    },
  },
  {
    id: 'each',
    op: 'core:foreach',
    params: {
      items: ['alpha', 'beta'],
      do: [{ id: 'type', op: 'browser:fill', params: { selector: '#q', text: '{{item}}' } }],
    },
  },
  {
    id: 'pick',
    op: 'core:switch',
    params: {
      cases: [
        {
          when: { from: 'flag', operator: 'eq', value: false },
          steps: [{ id: 'no', op: 'browser:click', params: { selector: '#no' } }],
        },
        {
          when: { from: 'flag', operator: 'eq', value: true },
          steps: [{ id: 'yes', op: 'browser:click_first_match', params: { selectors: ['#ok'] } }],
        },
      ],
    },
  },
  {
    id: 'flaky',
    op: 'browser:click',
    params: { selector: '#flaky' },
    on_error: {
      strategy: 'fallback',
      fallback: [
        { id: 'recover', op: 'browser:goto', params: { url: 'https://app.example.test/' } },
      ],
    },
  },
];

const manifest = compileRunManifest(STEPS, {
  inputPath: 'knowledge/confidential/acme/scenarios/parity.json',
  contentSha256: 'c'.repeat(64),
  scope: { tier: 'confidential', tenantSlug: 'acme' },
});

interface Dispatch {
  op: string;
  entryId?: string;
  authoredHash?: string;
  params: Record<string, unknown>;
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function recordBrowserDispatches(): Dispatch[] {
  const dispatched: Dispatch[] = [];
  disposers.push(
    registerScenarioOpOverride({
      resolve: ({ domain }) =>
        domain === 'browser'
          ? {
              stepType: 'apply',
              handler: async (op, params, ctx) => {
                const step = currentRunManifestStep();
                dispatched.push({
                  op,
                  ...(step
                    ? {
                        entryId: step.entryId,
                        authoredHash: computeApprovalPayloadHash(step.authoredParams ?? {}),
                      }
                    : {}),
                  params: Object.fromEntries(
                    Object.entries(params).filter(([key]) => !key.startsWith('_'))
                  ),
                });
                if (params.selector === '#flaky') throw new Error('element not found');
                const exportAs =
                  typeof params.export_as === 'string' ? params.export_as : undefined;
                return { handled: true, ctx: exportAs ? { ...ctx, [exportAs]: 'ok' } : ctx };
              },
            }
          : undefined,
      approvalGranted: () => true,
    })
  );
  return dispatched;
}

describe('run-manifest step paths at leaf dispatch', () => {
  it('marks every nested leaf with the compiler entry id and its authored params', async () => {
    const dispatched = recordBrowserDispatches();
    const result = await withRunManifestBinding(
      { manifest, charterId: 'charter-1', principal: 'attended', runId: 'run-1' },
      () => runValidatedSteps(STEPS, { flag: true }, { quiet: true, hasHuman: false })
    );
    expect(result.status, JSON.stringify(result.results)).toBe('succeeded');
    expect(dispatched.map((entry) => entry.entryId)).toEqual([
      '0',
      '1.then.0',
      '2.pipeline.0',
      '2.pipeline.0',
      '3.do.0',
      '3.do.0',
      '4.cases.1.steps.0',
      '5',
      '5.on_error.fallback.0',
    ]);
    const hashes = new Map(
      manifest.requirements.effects.map((entry) => [entry.entry_id, entry.params_template_hash])
    );
    for (const entry of dispatched) expect(entry.authoredHash).toBe(hashes.get(entry.entryId!));
    // The dispatched params are resolved; the authored template stays on the step.
    expect(
      dispatched.filter((entry) => entry.entryId === '3.do.0').map((e) => e.params.text)
    ).toEqual(['alpha', 'beta']);
    expect(dispatched[2].params.args).toEqual({ x: true });
  });

  it('leaves leaves unmarked when the run has no binding', async () => {
    const dispatched = recordBrowserDispatches();
    const result = await runValidatedSteps(STEPS.slice(0, 1), {}, { quiet: true, hasHuman: false });
    expect(result.status).toBe('succeeded');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].entryId).toBeUndefined();
  });

  it('never lets a nested run inherit the parent binding', async () => {
    await withRunManifestBinding(
      { manifest, charterId: 'charter-1', principal: 'attended', runId: 'run-1' },
      async () => {
        expect(currentRunManifestBinding()).toBeDefined();
        const inner = await withoutRunManifestBinding(async () => {
          // An async continuation (not a timer) proves the store survives await.
          await Promise.resolve();
          return currentRunManifestBinding();
        });
        expect(inner).toBeUndefined();
        expect(currentRunManifestBinding()?.runId).toBe('run-1');
      }
    );
  });

  it('never lets an untagged dispatch inherit the enclosing step entry', async () => {
    const [untagged] = prepareEngineSteps([
      { op: 'browser:click', params: { selector: '#x' } },
    ] as never) as never[];
    const [tagged] = prepareEngineSteps(
      [{ op: 'browser:click', params: { selector: '#x' } }] as never,
      ''
    ) as never[];
    await withRunManifestBinding(
      { manifest, charterId: 'charter-1', principal: 'attended', runId: 'run-1' },
      () =>
        withRunManifestStep({ entryId: '5' }, () => {
          expect(withManifestStep(untagged, 'browser', 'click', currentRunManifestStep)).toBe(
            undefined
          );
          expect(
            withManifestStep(tagged, 'browser', 'click', currentRunManifestStep)?.entryId
          ).toBe('0');
        })
    );
  });
});
