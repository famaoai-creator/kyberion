import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
const legacyIntentAsk = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./kyberion_home.js', () => ({ main: legacyIntentAsk }));
import {
  assertApprovedNextActionCommand,
  parseOffboardArgs,
  assertApprovedPipelinePath,
  assertPacketPathAllowed,
  classifyNextActionExecutionOutcome,
  extractBranchArg,
  main,
  normalizeActuators,
  formatOperatorPacketLines,
  searchActuators,
  shouldBootstrapRuntime,
  stripNpmSeparatorArg,
  routeLegacyIntentToAsk,
  readCliTextFile,
} from './cli.js';
import { handleTaskCommand, withWorkflowOutputPrinter } from './cli-workflow-handlers.js';

async function captureMainOutput(args: string[]): Promise<string> {
  const output: string[] = [];
  await main(args, (value) => output.push(String(value)));
  return output.join('\n');
}

describe('Kyberion CLI helpers', () => {
  it('rejects a directory replacement before CLI text parsing', () => {
    expect(() => readCliTextFile(pathResolver.rootDir(), 'CLI input')).toThrow(
      'CLI input must be a regular file'
    );
  });

  it('uses the governed parser for packet and pipeline preview files', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/cli.ts'), { encoding: 'utf8' })
    );
    expect(source).toContain("parseSafeJsonInput(content, 'Packet file')");
    expect(source).toContain("parseSafeJsonInput(content, 'Pipeline preview file')");
    expect(source).not.toContain('JSON.parse(content)');
    expect(source).not.toContain('process.env.MISSION_ID');
    expect(source).toContain("getRegisteredEnvText('MISSION_ID')");
  });

  it('routes legacy intent resolution to the canonical ask explanation path', async () => {
    const output: unknown[] = [];

    await routeLegacyIntentToAsk('prepare the weekly report', 'explain', (value) =>
      output.push(value)
    );

    expect(output).toEqual([
      '[DEPRECATED] `pnpm kyberion intent` is now routed to `pnpm kyberion ask --explain`; use the latter directly.',
    ]);
    expect(legacyIntentAsk).toHaveBeenCalledWith(
      ['ask', 'prepare the weekly report', '--explain'],
      expect.any(Function)
    );
    legacyIntentAsk.mockClear();
  });

  it('preserves legacy --clarify when routing to the canonical ask entrypoint', async () => {
    const output: unknown[] = [];

    await routeLegacyIntentToAsk('what is missing', 'clarify', (value) => output.push(value));

    expect(output).toEqual([
      '[DEPRECATED] `pnpm kyberion intent` is now routed to `pnpm kyberion ask --clarify`; use the latter directly.',
    ]);
    expect(legacyIntentAsk).toHaveBeenCalledWith(
      ['ask', 'what is missing', '--clarify'],
      expect.any(Function)
    );
    legacyIntentAsk.mockClear();
  });

  it('routes legacy --run through the same canonical ask entrypoint', async () => {
    const output: unknown[] = [];

    await main(['intent', 'prepare the weekly report', '--run'], (value) => output.push(value));

    expect(output).toContain(
      '[DEPRECATED] `pnpm kyberion intent` is now routed to `pnpm kyberion ask --explain`; use the latter directly.'
    );
    expect(legacyIntentAsk).toHaveBeenCalledWith(
      ['ask', 'prepare the weekly report', '--explain'],
      expect.any(Function)
    );
    legacyIntentAsk.mockClear();
  });

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

  it('skips runtime bootstrap for read-only CLI commands (LC-13)', () => {
    expect(shouldBootstrapRuntime(['--help'])).toBe(false);
    expect(shouldBootstrapRuntime(['list'])).toBe(false);
    expect(shouldBootstrapRuntime(['list', '--check'])).toBe(true);
    expect(shouldBootstrapRuntime(['task', 'plan', 'hello'])).toBe(true);
    expect(shouldBootstrapRuntime(['task', 'scenario', 'list'])).toBe(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('prints shared mobile app profile summary', async () => {
    const output = await captureMainOutput(['mobile-profiles']);
    expect(output).toContain('Mobile app profiles');
    expect(output).toContain('example-mobile-login-passkey');
    expect(output).toContain(
      'knowledge/product/orchestration/mobile-app-profiles/example-mobile-login-passkey.json'
    );
  });

  it('prints a specific shared mobile app profile', async () => {
    const output = await captureMainOutput(['mobile-profiles', 'example-mobile-login-passkey']);
    expect(output).toContain('example-mobile-login-passkey (android)');
    expect(output).toContain('Example Mobile Login + Passkey');
    expect(output).toContain(
      'Path: knowledge/product/orchestration/mobile-app-profiles/example-mobile-login-passkey.json'
    );
  });

  it('prints shared web app profile summary', async () => {
    const output = await captureMainOutput(['web-profiles']);
    expect(output).toContain('Web app profiles');
    expect(output).toContain('example-web-login-guarded');
    expect(output).toContain(
      'knowledge/product/orchestration/web-app-profiles/example-web-login-guarded.json'
    );
  });

  it('prints a specific shared web app profile', async () => {
    const output = await captureMainOutput(['web-profiles', 'example-web-login-guarded']);
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
    const output = await captureMainOutput(['help', '--locale', 'en']);
    expect(output).toContain('email <status|draft|latest-draft|deliver|archive-inbox>');
    expect(output).toContain('pnpm kyberion email status');
    expect(output).toContain('pnpm kyberion email draft');
    expect(output).toContain('calendar <status|list-calendars|agenda|freebusy|create-event>');
    expect(output).toContain('pnpm kyberion calendar status');
    expect(output).toContain('intent [--clarify] "<utterance>"');
    expect(output).toContain('task <plan|start> "<request>"');
  });

  it('renders help in Japanese when --locale ja is passed (UX-03)', async () => {
    const output = await captureMainOutput(['help', '--locale', 'ja']);
    expect(output).toContain('使い方: pnpm kyberion <コマンド> [引数]');
    expect(output).toContain('── アクチュエータ管理 ──');
    expect(output).toContain('Gmail 認証の準備状態を確認');
  });

  it('includes the inbox archive example in email help output', async () => {
    const output = await captureMainOutput(['email', 'help', '--locale', 'en']);
    expect(output).toContain('email <status|draft|latest-draft|deliver|archive-inbox>');
    expect(output).toContain('pnpm kyberion email archive-inbox --apply');
  });

  it('includes the calendar workflow command in help output', async () => {
    const output = await captureMainOutput(['calendar', 'help', '--locale', 'en']);
    expect(output).toContain('calendar <status|list-calendars|agenda|freebusy|create-event>');
    expect(output).toContain('pnpm kyberion calendar create-event --summary "Planning"');
  });

  it('keeps calendar JSON output machine-readable', async () => {
    const output = await captureMainOutput(['calendar', 'status', '--json']);
    expect(JSON.parse(output)).toHaveProperty('checked_at');
    expect(output).not.toContain('KYBERION CONSOLE');
  });

  it('rejects unsupported calendar providers', async () => {
    await expect(main(['calendar', 'status', '--provider', 'unknown'])).rejects.toThrow(
      'Unsupported calendar provider: unknown'
    );
  });

  it('previews a governed cross-tool task without external effects', async () => {
    const output = await captureMainOutput([
      'task',
      'plan',
      '会議の日程を変更して参加者にメールを送って',
    ]);
    expect(output).toContain('"kind": "productivity-task-plan"');
    expect(output).toContain('"external_write"');
    expect(output).toContain('"required": true');
    expect(output).toContain('"external_effects_executed": false');
  });

  it('shows task command help in Japanese', async () => {
    const output = await captureMainOutput(['task', 'help', '--locale', 'ja']);
    expect(output).toContain('使い方: pnpm kyberion task <plan|start>');
    expect(output).toContain('外部効果は引き続き停止');
  });

  it('routes TaskScenario workflows through the unified task namespace', async () => {
    const output: string[] = [];

    await withWorkflowOutputPrinter(
      (value) => output.push(String(value)),
      () => handleTaskCommand('scenario', ['list', '--json'], 'en')
    );

    const parsed = JSON.parse(output.join('')) as {
      status: string;
      scenarios: Array<{ id: string }>;
    };
    expect(parsed.status).toBe('ok');
    expect(parsed.scenarios.map((scenario) => scenario.id)).toContain('daily-email-triage');
  });

  it('parses an offboard dry run by default and needs no approval', () => {
    expect(parseOffboardArgs(['tenant', 'acme'])).toEqual({
      scopeType: 'tenant',
      scopeId: 'acme',
      mode: 'dry_run',
      json: false,
    });
    expect(parseOffboardArgs(['project', 'proj-alpha', '--json'])).toMatchObject({
      scopeType: 'project',
      mode: 'dry_run',
      json: true,
    });
  });

  it('refuses an offboard --execute without both approved-by and purpose (AL-04 fail-closed)', () => {
    expect(() => parseOffboardArgs(['tenant', 'acme', '--execute'])).toThrowError(/--approved-by/);
    expect(() =>
      parseOffboardArgs(['tenant', 'acme', '--execute', '--approved-by', 'founder'])
    ).toThrowError(/--purpose/);
    expect(() =>
      parseOffboardArgs(['tenant', 'acme', '--execute', '--purpose', 'contract ended'])
    ).toThrowError(/--approved-by/);
  });

  it('carries a complete offboard approval through', () => {
    expect(
      parseOffboardArgs([
        'tenant',
        'acme',
        '--execute',
        '--approved-by',
        'founder',
        '--purpose',
        'contract ended',
      ])
    ).toEqual({
      scopeType: 'tenant',
      scopeId: 'acme',
      mode: 'execute',
      json: false,
      approval: { approved_by: 'founder', purpose: 'contract ended' },
    });
  });

  it('rejects an unknown offboard scope kind or a missing id', () => {
    expect(() => parseOffboardArgs(['workspace', 'acme'])).toThrowError(/tenant.*project/);
    expect(() => parseOffboardArgs([])).toThrowError(/tenant.*project/);
    expect(() => parseOffboardArgs(['tenant'])).toThrowError(/requires a tenant id/);
    expect(() => parseOffboardArgs(['tenant', '--execute'])).toThrowError(/requires a tenant id/);
  });

  it('reports not_found (exit 0, no writes) for a scope with no active trees', async () => {
    const output: string[] = [];
    const previousExitCode = process.exitCode;

    await main(['offboard', 'tenant', 'kyberion-cli-test-absent-tenant', '--json'], (value) =>
      output.push(String(value))
    );

    expect(output.join('\n')).toContain('"status": "not_found"');
    expect(output.join('\n')).toContain('"soft_deleted": []');
    expect(process.exitCode ?? 0).toBe(previousExitCode ?? 0);
  });

  it('includes the offboarding command in help output', async () => {
    const output = await captureMainOutput(['help', '--locale', 'en']);
    expect(output).toContain('offboard <tenant|project> <id>');
    expect(output).toContain('pnpm kyberion offboard tenant acme');
  });

  it('shows offboard command help in Japanese (UX-03)', async () => {
    const output = await captureMainOutput(['offboard', 'help', '--locale', 'ja']);
    expect(output).toContain('使い方: pnpm kyberion offboard <tenant|project> <id>');
    expect(output).toContain('--approved-by と --purpose が必須');
    expect(output).toContain('復元可能');
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
        suggested_command: 'pnpm kyberion packet',
      },
      'command',
      'pnpm kyberion packet',
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
