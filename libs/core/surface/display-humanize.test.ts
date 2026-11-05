import { describe, expect, it } from 'vitest';
import {
  clampText,
  describeActor,
  humanizeSummary,
  readableMissionName,
  stripMachineText,
  stripIdPrefix,
} from './display-humanize.js';

const PR_SUMMARY =
  'Task: vcs:pr_create\n\nResult:\n- Created active/shared/artifacts/confidential/famao-ai/evidence/pr-publication/c4396aa619129eea16a92e80be87da7592c122316f3d9514fa4077ffc1b5db76/29533c06a309d71599a8fbc0c70763d8092b12a3b3b0dc8fa14ecba5373fe54d.json\n\nApproval required:\n- none\n\nDefault action:\n- unknown; no external delivery was performed';

describe('stripMachineText', () => {
  it('drops emptied list lines and stays linear on long tab runs (CodeQL js/polynomial-redos)', () => {
    expect(stripMachineText('- Created libs/core/a.ts\n- keep this').text).toBe('- keep this');
    const started = Date.now();
    stripMachineText(`*${'\t'.repeat(50_000)}x`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('removes repository paths, 64-hex digests and empty list lines', () => {
    const { text, stripped } = stripMachineText(PR_SUMMARY);
    expect(stripped).toBe(true);
    expect(text).not.toMatch(/[0-9a-f]{32,}/u);
    expect(text).not.toContain('active/shared');
    expect(text).not.toContain('- Created');
  });

  it('removes JSON blobs, prefixed hashes and UUIDs but keeps prose', () => {
    const { text } = stripMachineText(
      'Run failed {"code":500,"detail":{"x":[1,2]}} for pipeline:c4396aa619129eea16a92e80be87da7592c122316f3d9514fa4077ffc1b5db76 (579a5674-3e34-4bd3-9f68-4584ebb50bd8) — please retry.'
    );
    expect(text).toBe('Run failed for — please retry.');
  });

  it('leaves ordinary text untouched', () => {
    expect(stripMachineText('The first matching Chrome tab will be closed.')).toEqual({
      text: 'The first matching Chrome tab will be closed.',
      stripped: false,
    });
  });
});

describe('clampText / humanizeSummary', () => {
  it('clamps to about two lines at a word boundary with an ellipsis', () => {
    const long = 'word '.repeat(80).trim();
    const clamped = clampText(long, 60);
    expect(clamped.clamped).toBe(true);
    expect(clamped.short.length).toBeLessThanOrEqual(61);
    expect(clamped.short.endsWith('…')).toBe(true);
    expect(clamped.full).toBe(long);
  });

  it('does not clamp short text', () => {
    expect(humanizeSummary('短い文です。')).toMatchObject({
      short: '短い文です。',
      clamped: false,
    });
  });
});

describe('stripIdPrefix', () => {
  it('drops a leading entity id and keeps a title-only id', () => {
    expect(stripIdPrefix('MSN-CONT-B737332D594E0B122AAD75D8C273: テスト計画に沿って実行する')).toBe(
      'テスト計画に沿って実行する'
    );
    expect(stripIdPrefix('WI-12： Review the plan')).toBe('Review the plan');
    expect(stripIdPrefix('MSN-1:')).toBe('MSN-1:');
    expect(stripIdPrefix('P0-1 doctor/bootstrap 一本化')).toBe('P0-1 doctor/bootstrap 一本化');
    expect(stripIdPrefix('Note: plain words')).toBe('Note: plain words');
    expect(stripIdPrefix(undefined)).toBe('');
  });
});

describe('describeActor', () => {
  it('never shows a pipeline hash', () => {
    expect(
      describeActor('pipeline:c4396aa619129eea16a92e80be87da7592c122316f3d9514fa4077ffc1b5db76')
    ).toEqual({ key: 'ux_a_actor_pipeline' });
  });

  it('maps known service actors to localized labels', () => {
    expect(describeActor('vcs-publication-cli')).toEqual({ key: 'ux_a_actor_publication' });
    expect(describeActor('system-actuator')).toEqual({ key: 'ux_a_actor_system' });
  });

  it('uses the member / agent display name when known', () => {
    const names = (id: string) =>
      ({ owner: 'Famao', 'kyberion://agent/default/kyberion-prime': 'Kyberion Prime' })[id];
    expect(describeActor('user:owner', names)).toEqual({ text: 'Famao' });
    expect(describeActor('kyberion://agent/default/kyberion-prime', names)).toEqual({
      text: 'Kyberion Prime',
    });
  });

  it('humanizes agent refs and dot proposers without a lookup', () => {
    expect(describeActor('kyberion://agent/default/kyberion-prime')).toEqual({
      key: 'ux_a_actor_agent',
      params: { name: 'Kyberion Prime' },
    });
    expect(describeActor('dot:kyberion-productization')).toEqual({
      key: 'ux_a_actor_dot',
      params: { name: 'Kyberion Productization' },
    });
    expect(describeActor('user:owner')).toEqual({ text: 'owner' });
  });
});

describe('readableMissionName', () => {
  it.each([
    ['MSN-CLI-GOV-FIX-20261030', 'CLI GOV FIX (2026-10-30)'],
    ['MSN-SEMANTIC-JUDGMENT-20261031', 'SEMANTIC JUDGMENT (2026-10-31)'],
    ['MSN-FOLLOWUP-UX', 'FOLLOWUP UX'],
    ['MSN-LX3K2', 'MSN-LX3K2'],
    ['MSN-20261030', 'MSN-20261030'],
    ['MSN-X-99999999', 'X 99999999'],
    ['', ''],
  ])('%s → %s', (id, name) => {
    expect(readableMissionName(id)).toBe(name);
  });
});
