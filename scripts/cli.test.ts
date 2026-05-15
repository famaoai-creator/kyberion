import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertApprovedNextActionCommand,
  assertApprovedPipelinePath,
  assertPacketPathAllowed,
  classifyNextActionExecutionOutcome,
  extractBranchArg,
  main,
  normalizeActuators,
  searchActuators,
  stripNpmSeparatorArg,
} from './cli.js';

describe('Kyberion CLI helpers', () => {
  it('normalizes compact actuator index entries', () => {
    const actuators = normalizeActuators({
      s: [{ n: 'file-actuator', path: 'libs/actuators/file-actuator', d: 'File operations', s: 'implemented' }],
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
        { n: 'browser-actuator', path: 'libs/actuators/browser-actuator', d: 'Playwright web automation', s: 'implemented' },
        { n: 'service-actuator', path: 'libs/actuators/service-actuator', d: 'External SaaS connectors', s: 'implemented' },
      ],
    });

    expect(searchActuators(actuators, 'playwright').map(actuator => actuator.name)).toEqual(['browser-actuator']);
    expect(searchActuators(actuators, 'service-actuator').map(actuator => actuator.name)).toEqual(['service-actuator']);
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
  });

  it('prints shared mobile app profile summary', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['mobile-profiles']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Mobile app profiles');
    expect(output).toContain('example-mobile-login-passkey');
    expect(output).toContain('knowledge/public/orchestration/mobile-app-profiles/example-mobile-login-passkey.json');
  });

  it('prints a specific shared mobile app profile', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['mobile-profiles', 'example-mobile-login-passkey']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('example-mobile-login-passkey (android)');
    expect(output).toContain('Example Mobile Login + Passkey');
    expect(output).toContain('Path: knowledge/public/orchestration/mobile-app-profiles/example-mobile-login-passkey.json');
  });

  it('prints shared web app profile summary', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['web-profiles']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Web app profiles');
    expect(output).toContain('example-web-login-guarded');
    expect(output).toContain('knowledge/public/orchestration/web-app-profiles/example-web-login-guarded.json');
  });

  it('prints a specific shared web app profile', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['web-profiles', 'example-web-login-guarded']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('example-web-login-guarded (browser)');
    expect(output).toContain('Example Web Login + Guarded Routes');
    expect(output).toContain('Path: knowledge/public/orchestration/web-app-profiles/example-web-login-guarded.json');
  });

  it('allows only approved packet commands', () => {
    expect(() => assertApprovedNextActionCommand('node dist/scripts/mission_controller.js status MSN-1')).not.toThrow();
    expect(() => assertApprovedNextActionCommand('bash -lc "echo hacked"')).toThrow('Only node-based packet commands are allowed');
    expect(() => assertApprovedNextActionCommand('node -e "console.log(1)"')).toThrow('approved dist/scripts entrypoint');
    expect(() => assertApprovedNextActionCommand('node dist/scripts/archive_missions.js')).toThrow('not approved');
  });

  it('allows only approved packet and pipeline paths', () => {
    expect(() => assertPacketPathAllowed(`${process.cwd()}/active/shared/tmp/orchestrator/test-packet.json`)).not.toThrow();
    expect(() => assertPacketPathAllowed(`${process.cwd()}/tmp/evil.json`)).toThrow('Packet path must stay within');
    expect(() => assertApprovedPipelinePath('pipelines/web-session-handoff-runner.json')).not.toThrow();
    expect(() => assertApprovedPipelinePath('active/shared/tmp/orchestrator/status-packet.json')).not.toThrow();
    expect(() => assertApprovedPipelinePath('../secrets.json')).toThrow('Pipeline path is not approved');
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
      'ok',
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
      'Mission: MSN-TEST',
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
      'ERROR Missing packet path.',
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
      'mission_controller.js start is recommended',
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
      'mission_controller.js resume is recommended',
    );

    expect(outcome.recommended_next_action_type).toBe('resume_mission');
    expect(outcome.llm_consult_recommended).toBe(false);
  });
});
