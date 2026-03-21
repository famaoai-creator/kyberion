import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractBranchArg, main, normalizeActuators, searchActuators } from './cli.js';

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
});
