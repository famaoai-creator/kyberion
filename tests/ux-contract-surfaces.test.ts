import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { validateSurfaceUxContract } from '../libs/core/surface-ux-contract.js';
import { formatOperatorPacketLines } from '../scripts/cli.js';

const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-9;]*m/gu, '');

describe('operator output UX contract', () => {
  it('renders readiness and missing inputs without leaking raw enum values', () => {
    const text = formatOperatorPacketLines({
      kind: 'operator-interaction-packet',
      interaction_type: 'clarification',
      headline: 'Request: 月次レポートを作成します。',
      summary: 'Plan: 入力を確認してから結果を返します。',
      readiness: 'needs_clarification',
      confidence: 0.8,
      missing_inputs: ['対象期間'],
      omitted_question_count: 2,
      questions: [],
      next_actions: [],
    })
      .map(stripAnsi)
      .join('\n');

    expect(text).not.toContain('needs_clarification');
    expect(text).toContain('対象期間');
    expect(text).toContain('2');
    expect(validateSurfaceUxContract({ text }).valid).toBe(true);
  });
});

describe('IntentResolutionContract surface coverage', () => {
  const evidence: Array<{ surface: string; file: string; markers: string[] }> = [
    {
      surface: 'chronos-mirror-v2',
      file: 'presence/displays/chronos-mirror-v2/src/app/api/agent/agent-route-helpers.ts',
      markers: ['intentResolutionA2ui', 'contract.missing_inputs', 'contract.next_action'],
    },
    {
      surface: 'computer-surface',
      file: 'presence/displays/computer-surface/static/index.html',
      markers: [
        'intent-resolution-understanding',
        'intent-resolution-missing',
        'intent-resolution-outcome',
        'renderIntentResolution(data)',
      ],
    },
    {
      surface: 'concierge',
      file: 'presence/displays/concierge/src/app/conversation-dock.tsx',
      markers: ['buildIntentResolutionView', 'intent-resolution-card', 'missingInputs'],
    },
    {
      surface: 'discord-bridge',
      file: 'satellites/discord-bridge/src/index.ts',
      markers: ['runChannelTurn', 'intentResolution: result.intentResolution'],
    },
    {
      surface: 'imessage-bridge',
      file: 'satellites/imessage-bridge/src/index.ts',
      markers: ['runChannelTurn', 'result.intentResolution'],
    },
    {
      surface: 'mcp-server-cowork',
      file: 'libs/shared-network/src/mcp-server-engine.ts',
      markers: ['kyberion.surface.cowork.deliver', 'intent_resolution'],
    },
    {
      surface: 'presence-studio',
      file: 'presence/displays/presence-studio/static/index.html',
      markers: ['renderIntentResolution(body.intentResolution)', 'understanding', 'outcome_kind'],
    },
    {
      surface: 'operator-surface',
      file: 'presence/displays/operator-surface/src/app/intent-snapshots/page.tsx',
      markers: ['Resolution contract', 'contract.normalized_intent', 'contract.missing_inputs'],
    },
    {
      surface: 'slack-bridge',
      file: 'satellites/slack-bridge/src/index.ts',
      markers: ['runChannelTurn', 'conversation.intentResolution'],
    },
    {
      surface: 'telegram-bridge',
      file: 'satellites/telegram-bridge/src/index.ts',
      markers: ['runChannelTurn', 'result.intentResolution'],
    },
    {
      surface: 'terminal-hud',
      file: 'presence/displays/terminal-hud/src/components/intent-preview.tsx',
      markers: ['IntentPreview', 'contract.missing_inputs', 'contract.next_action'],
    },
    {
      surface: 'voice-hub',
      file: 'satellites/voice-hub/server.ts',
      markers: ['formatChannelTurnText', 'intentResolution'],
    },
  ];

  it('keeps every contract-bearing surface tied to an inspectable renderer', () => {
    expect(evidence).toHaveLength(12);
    for (const entry of evidence) {
      const source = String(
        safeReadFile(pathResolver.rootResolve(entry.file), { encoding: 'utf8' })
      );
      for (const marker of entry.markers) {
        expect(source, `${entry.surface} is missing ${marker}`).toContain(marker);
      }
    }
  });
});
