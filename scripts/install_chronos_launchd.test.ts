import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildChronosLaunchdPlist,
  chronosLaunchAgentTargetPath,
  CHRONOS_LAUNCHD_LABEL,
  launchAgentTargetPath,
  LAUNCHD_DAEMON_SPECS,
  main,
  resolveForwardedChronosEnv,
  resolveStableNodePath,
} from './install_chronos_launchd.js';

// LC-01d: plist generation is a pure string function — pin its load-bearing
// keys so a refactor cannot silently ship an agent that no longer restarts
// the scheduler.
describe('install_chronos_launchd plist generation', () => {
  const plist = buildChronosLaunchdPlist({
    nodePath: '/usr/local/bin/node',
    repoRoot: '/repo/kyberion',
    logDir: '/Users/alice/Library/Logs',
  });

  it('declares the com.kyberion.chronos label and repo working directory', () => {
    expect(CHRONOS_LAUNCHD_LABEL).toBe('com.kyberion.chronos');
    expect(plist).toContain('<string>com.kyberion.chronos</string>');
    expect(plist).toContain('<key>WorkingDirectory</key>');
    expect(plist).toContain('<string>/repo/kyberion</string>');
  });

  it('runs node against the built chronos daemon, in order', () => {
    const nodeIndex = plist.indexOf('<string>/usr/local/bin/node</string>');
    const scriptIndex = plist.indexOf(
      '<string>/repo/kyberion/dist/scripts/chronos_daemon.js</string>'
    );
    expect(nodeIndex).toBeGreaterThan(-1);
    expect(scriptIndex).toBeGreaterThan(nodeIndex);
  });

  it('keeps the daemon alive across exits and starts it at load', () => {
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
  });

  it('routes stdout/stderr under the boot-volume log dir, not the repo', () => {
    // launchd fails spawn with EX_CONFIG when Standard*Path targets live on
    // an external volume (verified live 2026-08-08), so the logs must stay
    // under ~/Library/Logs even though the repo has its own logs dir.
    expect(plist).toContain('<string>/Users/alice/Library/Logs/kyberion-chronos.log</string>');
    expect(plist).toContain('<string>/Users/alice/Library/Logs/kyberion-chronos.err.log</string>');
    expect(plist).not.toContain('active/shared/logs/chronos-daemon.log');
  });

  it('extends PATH so scheduled pipelines can shell out to node/pnpm', () => {
    expect(plist).toContain('<key>EnvironmentVariables</key>');
    expect(plist).toContain(
      '<string>/usr/local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>'
    );
  });

  it('escapes XML-significant characters in injected paths', () => {
    const escaped = buildChronosLaunchdPlist({
      nodePath: '/opt/tools & bins/node',
      repoRoot: '/tmp/<repo>',
      logDir: '/Users/alice/Library/Logs',
    });
    expect(escaped).toContain('/opt/tools &amp; bins/node');
    expect(escaped).toContain('&lt;repo&gt;');
    expect(escaped).not.toContain('<repo>');
  });

  it('forwards allowlisted daemon settings and refuses anything else', () => {
    const withEnv = buildChronosLaunchdPlist({
      nodePath: '/usr/local/bin/node',
      repoRoot: '/repo/kyberion',
      logDir: '/Users/alice/Library/Logs',
      env: { KYBERION_CHRONOS_SCHEDULES: 'organization-daily-digest' },
    });
    expect(withEnv).toContain(
      '<key>KYBERION_CHRONOS_SCHEDULES</key>\n    <string>organization-daily-digest</string>'
    );
    expect(() =>
      buildChronosLaunchdPlist({
        nodePath: '/usr/local/bin/node',
        repoRoot: '/repo/kyberion',
        logDir: '/Users/alice/Library/Logs',
        env: { SLACK_BOT_TOKEN: 'test-token' },
      })
    ).toThrow(/cannot be forwarded/);
  });

  it('checks the forwardable allowlist before reading any shell value', () => {
    const readEnv = vi.fn((name: string) => `value-of-${name}`);
    expect(() =>
      resolveForwardedChronosEnv(['KYBERION_PERSONA', 'SLACK_BOT_TOKEN'], readEnv)
    ).toThrow(/SLACK_BOT_TOKEN cannot be forwarded/);
    expect(readEnv).not.toHaveBeenCalledWith('SLACK_BOT_TOKEN');
    expect(resolveForwardedChronosEnv(['KYBERION_PERSONA'], readEnv)).toEqual({
      KYBERION_PERSONA: 'value-of-KYBERION_PERSONA',
    });
  });

  it('targets the per-user LaunchAgents directory', () => {
    expect(chronosLaunchAgentTargetPath('/Users/alice')).toBe(
      '/Users/alice/Library/LaunchAgents/com.kyberion.chronos.plist'
    );
  });

  it('is well-formed enough for plutil to accept it (macOS only)', () => {
    // Structural sanity without a plist parser dependency: balanced dicts
    // (top-level + EnvironmentVariables) and the xml/plist envelope.
    expect(plist.match(/<dict>/g)).toHaveLength(2);
    expect(plist.match(/<\/dict>/g)).toHaveLength(2);
    expect(plist).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(plist.trimEnd()).toMatch(/<\/plist>$/);
  });

  it('routes dry-run output through the shared script harness printer', () => {
    const source = readFileSync(new URL('./install_chronos_launchd.ts', import.meta.url), 'utf8');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
    expect(source).not.toContain('console.log(');
  });

  it('keeps uninstall dry-run output injectable and side-effect free', async () => {
    const output: string[] = [];
    await main(['--uninstall'], (value) => output.push(String(value)));

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('Uninstall steps (dry-run: nothing was changed)');
    expect(output[0]).toContain('pnpm kyberion chronos uninstall --apply');
  });
});

// The original agent died permanently when `brew upgrade node` removed the
// Cellar path baked into ProgramArguments (spawn failed → penalty box). The
// installer must pin the version-independent opt symlink instead.
describe('resolveStableNodePath', () => {
  it('maps a Homebrew Cellar node path to the opt symlink when it exists', () => {
    const exists = (p: string) => p === '/opt/homebrew/opt/node/bin/node';
    expect(resolveStableNodePath('/opt/homebrew/Cellar/node/26.10.0_1/bin/node', exists)).toBe(
      '/opt/homebrew/opt/node/bin/node'
    );
  });

  it('keeps the Intel Homebrew prefix layout working', () => {
    const exists = (p: string) => p === '/usr/local/opt/node/bin/node';
    expect(resolveStableNodePath('/usr/local/Cellar/node/24.0.0/bin/node', exists)).toBe(
      '/usr/local/opt/node/bin/node'
    );
  });

  it('falls back to the exec path when the opt symlink is absent', () => {
    const execPath = '/opt/homebrew/Cellar/node/26.10.0_1/bin/node';
    expect(resolveStableNodePath(execPath, () => false)).toBe(execPath);
  });

  it('leaves non-Cellar node paths (nvm, pkg installer) unchanged', () => {
    const exists = vi.fn(() => true);
    expect(resolveStableNodePath('/Users/alice/.nvm/versions/node/v22.1.0/bin/node', exists)).toBe(
      '/Users/alice/.nvm/versions/node/v22.1.0/bin/node'
    );
    expect(exists).not.toHaveBeenCalled();
  });
});

describe('install_chronos_launchd --daemon', () => {
  it('registers the generation schedule daemon with heartbeat and log names', () => {
    const spec = LAUNCHD_DAEMON_SPECS['generation-schedule'];
    expect(spec.label).toBe('com.kyberion.generation-schedule');
    expect(spec.daemonScript).toBe('dist/scripts/run_generation_schedule_daemon.js');
    expect(spec.verificationHint).toContain('generation-schedule-daemon.json');
  });

  it('generates an interval (not KeepAlive) agent for the watchdog', async () => {
    const output: string[] = [];
    await main(['--daemon', 'daemon-watchdog'], (value) => output.push(String(value)));

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('com.kyberion.daemon-watchdog');
    expect(output[0]).toContain('dist/scripts/daemon_watchdog.js');
    expect(output[0]).toContain('<key>StartInterval</key>');
    // A one-shot checker must not be kept resident by launchd.
    expect(output[0]).not.toContain('<key>KeepAlive</key>');
  });

  it('generates a plist for a non-chronos daemon via --daemon', async () => {
    const output: string[] = [];
    await main(['--daemon', 'generation-schedule'], (value) => output.push(String(value)));

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('com.kyberion.generation-schedule');
    expect(output[0]).toContain('dist/scripts/run_generation_schedule_daemon.js');
    expect(output[0]).toContain('kyberion-generation-schedule.err.log');
    expect(output[0]).not.toContain('chronos_daemon.js');
  });

  it('rejects an unknown daemon id before touching the filesystem', async () => {
    await expect(main(['--daemon', 'bogus'], () => {})).rejects.toThrow(
      /unknown daemon 'bogus'.*chronos.*generation-schedule/
    );
  });

  it('derives the LaunchAgent path from the spec label', () => {
    expect(launchAgentTargetPath('com.kyberion.generation-schedule', '/Users/alice')).toBe(
      '/Users/alice/Library/LaunchAgents/com.kyberion.generation-schedule.plist'
    );
  });
});
