import { describe, expect, it } from 'vitest';
import { buildLaunchdPlist } from './launchd.js';
import { buildSystemdServiceUnit } from './systemd-user.js';
import {
  deriveUnitRepoRoot,
  inspectInstalledUnitDetails,
  inspectInstalledUnits,
  parseKyberionUnitLabel,
  parsePlistXml,
  unitDriftSha256,
  type InstalledUnitsExec,
} from './installed-units.js';
import { DAEMON_SPECS, daemonInstanceFromCanonicalRoot, scopeDaemonServiceSpec } from './specs.js';
import type { DaemonRenderContext } from './service-manager.js';

const MINE = '/repos/mine';
const OTHER = '/repos/other';
const HOME = '/Users/op';
const mine = daemonInstanceFromCanonicalRoot(MINE, 'darwin');
const other = daemonInstanceFromCanonicalRoot(OTHER, 'darwin');

function plist(label: string, repoRoot: string, script = 'dist/scripts/chronos_daemon.js') {
  return buildLaunchdPlist(
    { nodePath: '/opt/homebrew/opt/node/bin/node', repoRoot, logDir: `${HOME}/Library/Logs` },
    { label, daemonScript: script, logBaseName: 'kyberion-test' }
  );
}

/** A hand-written legacy template: no WorkingDirectory, root only in the script path. */
const LEGACY_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kyberion.daemon-watchdog</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/node</string><string>${MINE}/dist/scripts/daemon_watchdog.js</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;

function host(files: Record<string, string>, loaded: Set<string> = new Set()) {
  const calls: string[][] = [];
  const exec: InstalledUnitsExec = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'launchctl' && args[0] === 'print') {
      const label = args[1]!.split('/').pop()!;
      return loaded.has(label)
        ? { status: 0, stdout: 'state = running', stderr: '' }
        : { status: 113, stdout: '', stderr: 'Could not find service' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  return {
    calls,
    options: {
      platform: 'darwin' as const,
      repoRoot: MINE,
      canonicalize: (root: string) => root,
      homeDir: HOME,
      uid: '501',
      exec,
      listDir: (dir: string) =>
        Object.keys(files)
          .filter((file) => file.startsWith(`${dir}/`))
          .map((file) => file.slice(dir.length + 1)),
      readFile: (file: string) => files[file] ?? null,
    },
  };
}

const agents = `${HOME}/Library/LaunchAgents`;

describe('installed-units (darwin)', () => {
  it('classifies legacy, scoped and foreign-checkout units', () => {
    const scopedLabel = scopeDaemonServiceSpec(DAEMON_SPECS.chronos!, mine).label;
    const foreignScoped = scopeDaemonServiceSpec(DAEMON_SPECS.chronos!, other).label;
    const { options } = host(
      {
        [`${agents}/com.kyberion.chronos.plist`]: plist('com.kyberion.chronos', MINE),
        [`${agents}/${scopedLabel}.plist`]: plist(scopedLabel, MINE),
        [`${agents}/${foreignScoped}.plist`]: plist(foreignScoped, OTHER),
        [`${agents}/com.kyberion.agent-runtime-supervisor.plist`]: plist(
          'com.kyberion.agent-runtime-supervisor',
          OTHER,
          'dist/scripts/agent_runtime_supervisor_daemon.js'
        ),
        [`${agents}/com.kyberion.daemon-watchdog.plist`]: LEGACY_TEMPLATE,
        [`${agents}/com.example.unrelated.plist`]: plist('com.example.unrelated', MINE),
      },
      new Set([scopedLabel, 'com.kyberion.chronos'])
    );
    const report = inspectInstalledUnits(options);
    expect(report).toMatchObject({ platform: 'darwin', instanceId: mine.id, repoRoot: MINE });
    const byLabel = Object.fromEntries(report.units.map((unit) => [unit.label, unit]));
    expect(Object.keys(byLabel).sort()).toEqual(
      [
        'com.kyberion.agent-runtime-supervisor',
        'com.kyberion.chronos',
        'com.kyberion.daemon-watchdog',
        scopedLabel,
        foreignScoped,
      ].sort()
    );
    expect(byLabel['com.kyberion.chronos']).toEqual({
      id: 'chronos',
      label: 'com.kyberion.chronos',
      scope: 'legacy',
      repoRoot: MINE,
      ownedByThisCheckout: true,
      loaded: true,
    });
    expect(byLabel[scopedLabel]).toMatchObject({
      id: 'chronos',
      scope: 'scoped',
      ownedByThisCheckout: true,
      loaded: true,
    });
    expect(byLabel[foreignScoped]).toMatchObject({
      scope: 'scoped',
      repoRoot: OTHER,
      ownedByThisCheckout: false,
      loaded: false,
    });
    expect(byLabel['com.kyberion.agent-runtime-supervisor']).toMatchObject({
      id: 'agent-runtime-supervisor',
      scope: 'legacy',
      repoRoot: OTHER,
      ownedByThisCheckout: false,
    });
    // Root derived from the ProgramArguments script path when nothing else names it.
    expect(byLabel['com.kyberion.daemon-watchdog']).toMatchObject({
      id: 'daemon-watchdog',
      repoRoot: MINE,
      ownedByThisCheckout: true,
    });
    // The contract shape carries exactly the documented fields.
    expect(Object.keys(byLabel[scopedLabel]!).sort()).toEqual(
      ['id', 'label', 'loaded', 'ownedByThisCheckout', 'repoRoot', 'scope'].sort()
    );
  });

  it('reports loaded: null without probing when probeLoaded is false', () => {
    const { options, calls } = host({
      [`${agents}/com.kyberion.chronos.plist`]: plist('com.kyberion.chronos', MINE),
    });
    const report = inspectInstalledUnits({ ...options, probeLoaded: false });
    expect(report.units[0]!.loaded).toBeNull();
    expect(calls).toEqual([]);
  });

  it('exposes hash, node path and environment for the reconcile planner', () => {
    const text = plist('com.kyberion.chronos', MINE);
    const { options } = host({ [`${agents}/com.kyberion.chronos.plist`]: text });
    const [unit] = inspectInstalledUnitDetails(options).units;
    expect(unit!.nodePath).toBe('/opt/homebrew/opt/node/bin/node');
    expect(unit!.environment.KYBERION_ROOT).toBe(MINE);
    expect(unit!.unitSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('survives an unreadable plist by falling back to the file name', () => {
    const { options } = host({});
    const report = inspectInstalledUnits({
      ...options,
      listDir: () => ['com.kyberion.chronos.plist'],
      readFile: () => null,
    });
    expect(report.units[0]).toMatchObject({
      id: 'chronos',
      scope: 'legacy',
      repoRoot: null,
      ownedByThisCheckout: false,
    });
  });
});

describe('installed-units (linux)', () => {
  it('reads systemd user units and their checkout', () => {
    const spec = scopeDaemonServiceSpec(
      DAEMON_SPECS.chronos!,
      daemonInstanceFromCanonicalRoot(MINE, 'linux')
    );
    const ctx: DaemonRenderContext = {
      nodePath: '/usr/bin/node',
      repoRoot: MINE,
      homeDir: '/home/op',
      uid: '1000',
      stagingDir: '/tmp/x',
    };
    const dir = '/home/op/.config/systemd/user';
    const files: Record<string, string> = {
      [`${dir}/kyberion-chronos-${spec.instanceId}.service`]: buildSystemdServiceUnit(spec, ctx),
      [`${dir}/kyberion-chronos.service`]: buildSystemdServiceUnit(DAEMON_SPECS.chronos!, {
        ...ctx,
        repoRoot: OTHER,
      }),
    };
    const report = inspectInstalledUnits({
      platform: 'linux',
      repoRoot: MINE,
      canonicalize: (root) => root,
      homeDir: '/home/op',
      probeLoaded: false,
      listDir: (target) =>
        Object.keys(files)
          .filter((file) => file.startsWith(`${target}/`))
          .map((file) => file.slice(target.length + 1)),
      readFile: (file) => files[file] ?? null,
    });
    expect(report.units).toEqual([
      {
        id: 'chronos',
        label: spec.label,
        scope: 'scoped',
        repoRoot: MINE,
        ownedByThisCheckout: true,
        loaded: null,
      },
      {
        id: 'chronos',
        label: 'com.kyberion.chronos',
        scope: 'legacy',
        repoRoot: OTHER,
        ownedByThisCheckout: false,
        loaded: null,
      },
    ]);
  });
});

describe('installed-units helpers', () => {
  it('returns an empty report with a note on Windows', () => {
    const report = inspectInstalledUnits({
      platform: 'win32',
      repoRoot: 'C:\\repos\\mine',
      canonicalize: (root) => root,
    });
    expect(report.platform).toBe('win32');
    expect(report.units).toEqual([]);
    expect(report.note).toMatch(/Task Scheduler/);
  });

  it('parses labels, plists and repo roots', () => {
    expect(parseKyberionUnitLabel('com.kyberion.daemon-watchdog')).toEqual({
      id: 'daemon-watchdog',
      instanceId: null,
    });
    expect(parseKyberionUnitLabel(`com.kyberion.chronos.${mine.id}`)).toEqual({
      id: 'chronos',
      instanceId: mine.id,
    });
    expect(parseKyberionUnitLabel('com.example.chronos')).toBeNull();
    expect(
      parsePlistXml('<plist><dict><key>A</key><string>x &amp; y</string></dict></plist>')
    ).toEqual({
      A: 'x & y',
    });
    expect(parsePlistXml('not a plist')).toBeNull();
    expect(deriveUnitRepoRoot({ programArguments: ['/n', '/r/k/dist/scripts/x.js'] })).toBe('/r/k');
    expect(deriveUnitRepoRoot({ environment: { KYBERION_ROOT: '/r/env/' } })).toBe('/r/env');
    expect(deriveUnitRepoRoot({})).toBeNull();
  });
});

describe('unit drift hash', () => {
  const spec = scopeDaemonServiceSpec(
    DAEMON_SPECS.chronos!,
    daemonInstanceFromCanonicalRoot(MINE, 'linux')
  );
  const ctx = (userPath: string[], nodePath = '/usr/bin/node'): DaemonRenderContext => ({
    nodePath,
    repoRoot: MINE,
    homeDir: '/home/op',
    uid: '1000',
    stagingDir: '/tmp/x',
    userPath,
  });

  it('ignores the PATH baked from the installing shell (launchd and systemd)', () => {
    const launchd = (extraPath: string[]) =>
      buildLaunchdPlist(
        { nodePath: '/opt/homebrew/opt/node/bin/node', repoRoot: MINE, logDir: '/l', extraPath },
        { label: 'com.kyberion.chronos', daemonScript: 'd.js', logBaseName: 'k' }
      );
    expect(launchd(['/a/bin'])).not.toBe(launchd(['/b/bin', '/c dir/bin']));
    expect(unitDriftSha256(launchd(['/a/bin']))).toBe(
      unitDriftSha256(launchd(['/b/bin', '/c dir/bin']))
    );
    const systemd = (userPath: string[]) => buildSystemdServiceUnit(spec, ctx(userPath));
    expect(unitDriftSha256(systemd(['/a/bin']))).toBe(
      unitDriftSha256(systemd(['/b/bin', '/c dir/bin']))
    );
  });

  it('still detects every other content change', () => {
    expect(unitDriftSha256(buildSystemdServiceUnit(spec, ctx([])))).not.toBe(
      unitDriftSha256(buildSystemdServiceUnit(spec, ctx([], '/opt/node/bin/node')))
    );
  });
});

describe('parsePlistXml tokenizer', () => {
  it('drops declarations, comments and doctype without regex backtracking', () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "x" "y"><!-- <!-- nested --><plist version="1.0"><dict><key>Label</key><string>a&amp;b</string><!-- c --></dict></plist>';
    expect(parsePlistXml(xml)).toEqual({ Label: 'a&b' });
  });

  it('handles many repeated declarations in linear time', () => {
    const xml = '<?xml'.repeat(50_000);
    const started = Date.now();
    expect(parsePlistXml(xml)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
