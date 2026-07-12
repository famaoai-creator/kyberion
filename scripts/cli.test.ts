import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertApprovedNextActionCommand,
  assertApprovedPipelinePath,
  assertPacketPathAllowed,
  classifyNextActionExecutionOutcome,
  extractBranchArg,
  main,
  normalizeActuators,
  formatOperatorPacketLines,
  searchActuators,
  stripNpmSeparatorArg,
} from './cli.js';

describe('Kyberion CLI helpers', () => {
  it('normalizes compact actuator index entries', () => {
    const actuators = normalizeActuators({
      s: [
        {
          n: 'file-actuator',
          path: 'libs/actuators/file-actuator',
          d: 'File operations',
          s: 'implemented',
        },
      ],
    });

    expect(actuators).toEqual([
      {
        name: 'file-actuator',
        path: 'libs/actuators/file-actuator',
        description: 'File operations',
        status: 'implemented',
      },
    ]);
  });

  it('searches name, description, and path', () => {
    const actuators = normalizeActuators({
      s: [
        {
          n: 'browser-actuator',
          path: 'libs/actuators/browser-actuator',
          d: 'Playwright web automation',
          s: 'implemented',
        },
        {
          n: 'service-actuator',
          path: 'libs/actuators/service-actuator',
          d: 'External SaaS connectors',
          s: 'implemented',
        },
      ],
    });

    expect(searchActuators(actuators, 'playwright').map((actuator) => actuator.name)).toEqual([
      'browser-actuator',
    ]);
    expect(searchActuators(actuators, 'service-actuator').map((actuator) => actuator.name)).toEqual(
      ['service-actuator']
    );
  });

  it('extracts and removes the branch option from forwarded args', () => {
    const result = extractBranchArg(['--branch', 'ceo-mode', '--', '--help']);

    expect(result).toEqual({
      branchId: 'ceo-mode',
      args: ['--', '--help'],
    });
  });

  it('drops npm separator tokens before dispatching commands', () => {
    expect(stripNpmSeparatorArg(['preview', '--', 'pipelines/baseline-check.json'])).toEqual([
      'preview',
      'pipelines/baseline-check.json',
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('prints shared mobile app profile summary', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['mobile-profiles']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Mobile app profiles');
    expect(output).toContain('example-mobile-login-passkey');
    expect(output).toContain(
      'knowledge/product/orchestration/mobile-app-profiles/example-mobile-login-passkey.json'
    );
  });

  it('prints a specific shared mobile app profile', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['mobile-profiles', 'example-mobile-login-passkey']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('example-mobile-login-passkey (android)');
    expect(output).toContain('Example Mobile Login + Passkey');
    expect(output).toContain(
      'Path: knowledge/product/orchestration/mobile-app-profiles/example-mobile-login-passkey.json'
    );
  });

  it('prints shared web app profile summary', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['web-profiles']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Web app profiles');
    expect(output).toContain('example-web-login-guarded');
    expect(output).toContain(
      'knowledge/product/orchestration/web-app-profiles/example-web-login-guarded.json'
    );
  });

  it('prints a specific shared web app profile', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['web-profiles', 'example-web-login-guarded']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('example-web-login-guarded (browser)');
    expect(output).toContain('Example Web Login + Guarded Routes');
    expect(output).toContain(
      'Path: knowledge/product/orchestration/web-app-profiles/example-web-login-guarded.json'
    );
  });

  it('renders operator packet readiness through the shared vocabulary catalog', () => {
    vi.stubEnv('KYBERION_UI_LOCALE', 'ja');
    const lines = formatOperatorPacketLines({
      kind: 'operator-interaction-packet',
      interaction_type: 'status-summary',
      headline: 'Status',
      summary: 'Summary',
      readiness: 'needs_clarification',
    });

    expect(lines.join('\n')).toContain('実行準備度: 追加確認が必要');
  });

  it('includes the email workflow command in help output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['help', '--locale', 'en']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('email <status|draft|latest-draft|deliver|archive-inbox>');
    expect(output).toContain('npm run cli -- email status');
    expect(output).toContain('npm run cli -- email draft');
    expect(output).toContain('calendar <status|list-calendars|agenda|freebusy|create-event>');
    expect(output).toContain('npm run cli -- calendar status');
    expect(output).toContain('intent [--clarify] "<utterance>"');
    expect(output).toContain('task <plan|start> "<request>"');
  });

  it('renders help in Japanese when --locale ja is passed (UX-03)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['help', '--locale', 'ja']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('使い方: npm run cli -- <コマンド> [引数]');
    expect(output).toContain('── アクチュエータ管理 ──');
    expect(output).toContain('Gmail 認証の準備状態を確認');
  });

  it('includes the inbox archive example in email help output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['email', 'help', '--locale', 'en']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('email <status|draft|latest-draft|deliver|archive-inbox>');
    expect(output).toContain('npm run cli -- email archive-inbox --apply');
  });

  it('includes the calendar workflow command in help output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['calendar', 'help', '--locale', 'en']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('calendar <status|list-calendars|agenda|freebusy|create-event>');
    expect(output).toContain('npm run cli -- calendar create-event --summary "Planning"');
  });

  it('previews a governed cross-tool task without external effects', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['task', 'plan', '会議の日程を変更して参加者にメールを送って']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('"kind": "productivity-task-plan"');
    expect(output).toContain('"external_write"');
    expect(output).toContain('"required": true');
    expect(output).toContain('"external_effects_executed": false');
  });

  it('shows task command help in Japanese', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['task', 'help', '--locale', 'ja']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('使い方: npm run cli -- task <plan|start>');
    expect(output).toContain('外部効果は引き続き停止');
  });

  it('allows only approved packet commands', () => {
    expect(() =>
      assertApprovedNextActionCommand('node dist/scripts/mission_controller.js status MSN-1')
    ).not.toThrow();
    expect(() => assertApprovedNextActionCommand('bash -lc "echo hacked"')).toThrow(
      'Only node-based packet commands are allowed'
    );
    expect(() => assertApprovedNextActionCommand('node -e "console.log(1)"')).toThrow(
      'approved dist/scripts entrypoint'
    );
    expect(() => assertApprovedNextActionCommand('node dist/scripts/archive_missions.js')).toThrow(
      'not approved'
    );
  });

  it('allows only approved packet and pipeline paths', () => {
    expect(() =>
      assertPacketPathAllowed(`${process.cwd()}/active/shared/tmp/orchestrator/test-packet.json`)
    ).not.toThrow();
    expect(() => assertPacketPathAllowed(`${process.cwd()}/tmp/evil.json`)).toThrow(
      'Packet path must stay within'
    );
    expect(() =>
      assertApprovedPipelinePath('pipelines/web-session-handoff-runner.json')
    ).not.toThrow();
    expect(() =>
      assertApprovedPipelinePath('active/shared/tmp/orchestrator/status-packet.json')
    ).not.toThrow();
    expect(() => assertApprovedPipelinePath('../secrets.json')).toThrow(
      'Pipeline path is not approved'
    );
  });
});

describe('next action outcome classification', () => {
  const packetPath = 'active/shared/tmp/orchestrator/test-packet.json';

  it('keeps execute_now when the action declares it explicitly', () => {
    const outcome = classifyNextActionExecutionOutcome(
      packetPath,
      {
        id: 'execute-now',
        action: 'Run immediately',
        next_action_type: 'execute_now',
        suggested_command: 'node -e "console.log(\'ok\')"',
      },
      'command',
      'node -e "console.log(\'ok\')"',
      false,
      undefined,
      'ok'
    );

    expect(outcome.recommended_next_action_type).toBe('execute_now');
    expect(outcome.llm_consult_recommended).toBe(false);
    expect(outcome.execution_failed).toBe(false);
  });

  it('keeps inspect when the action declares it explicitly', () => {
    const outcome = classifyNextActionExecutionOutcome(
      packetPath,
      {
        id: 'inspect',
        action: 'Inspect artifacts',
        next_action_type: 'inspect',
        suggested_command: 'node dist/scripts/mission_controller.js status MSN-TEST',
      },
      'command',
      'node dist/scripts/mission_controller.js status MSN-TEST',
      false,
      undefined,
      'Mission: MSN-TEST'
    );

    expect(outcome.recommended_next_action_type).toBe('inspect');
    expect(outcome.llm_consult_recommended).toBe(false);
  });

  it('keeps clarify and recommends LLM consultation when execution fails', () => {
    const outcome = classifyNextActionExecutionOutcome(
      packetPath,
      {
        id: 'clarify',
        action: 'Ask for missing input',
        next_action_type: 'clarify',
        suggested_command: 'node dist/scripts/cli.js packet',
      },
      'command',
      'node dist/scripts/cli.js packet',
      true,
      'Missing packet path.',
      'ERROR Missing packet path.'
    );

    expect(outcome.recommended_next_action_type).toBe('clarify');
    expect(outcome.llm_consult_recommended).toBe(true);
    expect(outcome.execution_failed).toBe(true);
    expect(outcome.failure_summary).toContain('Missing packet path');
    expect(outcome.llm_consult_prompt).toContain('clarify');
  });

  it('keeps start_mission when the action declares it explicitly', () => {
    const outcome = classifyNextActionExecutionOutcome(
      packetPath,
      {
        id: 'start-mission',
        action: 'Start a durable mission',
        next_action_type: 'start_mission',
        suggested_command: 'node -e "console.log(\'mission_controller.js start\')"',
      },
      'command',
      'node -e "console.log(\'mission_controller.js start\')"',
      false,
      undefined,
      'mission_controller.js start is recommended'
    );

    expect(outcome.recommended_next_action_type).toBe('start_mission');
    expect(outcome.llm_consult_recommended).toBe(false);
  });

  it('keeps resume_mission when the action declares it explicitly', () => {
    const outcome = classifyNextActionExecutionOutcome(
      packetPath,
      {
        id: 'resume-mission',
        action: 'Resume an existing mission',
        next_action_type: 'resume_mission',
        suggested_command: 'node -e "console.log(\'mission_controller.js resume\')"',
      },
      'command',
      'node -e "console.log(\'mission_controller.js resume\')"',
      false,
      undefined,
      'mission_controller.js resume is recommended'
    );

    expect(outcome.recommended_next_action_type).toBe('resume_mission');
    expect(outcome.llm_consult_recommended).toBe(false);
  });
});
