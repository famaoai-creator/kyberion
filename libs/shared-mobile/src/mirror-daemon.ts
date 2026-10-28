import { logger } from '@agent/core/core';
import { safeWriteFile, safeMkdir } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import * as path from 'node:path';
import { SimctlScreenshotSource, AdbScreencapSource, type FrameSource } from './frame-source.js';
import { AxeInjector, AdbInjector, type InputInjector } from './input-injector.js';
import { startMirrorServer } from './mirror-server.js';

/**
 * Detached mirror process spawned by actuator `start_screen_stream` ops via
 * spawnManagedProcess. Writes a state file so sibling ops can read back the
 * bound port and URLs, then idles until SIGTERM.
 *
 *   node mirror-daemon.js --platform ios --udid <UDID> --state-file <path>
 *                        [--fps 3] [--port 0] [--no-input]
 *   node mirror-daemon.js --platform android [--serial <S>] --state-file <path> ...
 */
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[arg.slice(2)] = next;
        i += 1;
      } else {
        out[arg.slice(2)] = 'true';
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = args.platform;
  const stateFile = args['state-file'];
  if ((platform !== 'ios' && platform !== 'android') || !stateFile) {
    throw new Error('mirror-daemon requires --platform ios|android and --state-file <path>');
  }

  const fps = Number(args.fps || 3);
  const port = Number(args.port || 0);
  const noInput = args['no-input'] === 'true';
  const scratchDir = pathResolver.sharedTmp(`mobile-mirror/${process.pid}`);

  let frameSource: FrameSource;
  let injector: InputInjector | undefined;
  if (platform === 'ios') {
    const udid = args.udid || 'booted';
    frameSource = new SimctlScreenshotSource({ udid, scratchDir });
    injector = noInput ? undefined : new AxeInjector({ udid });
  } else {
    const serial = args.serial || '';
    frameSource = new AdbScreencapSource({ serial, scratchDir });
    injector = noInput ? undefined : new AdbInjector({ serial });
  }

  const handle = await startMirrorServer({
    frameSource,
    injector,
    fps,
    port,
    deviceLabel: frameSource.label,
  });

  const stateDir = path.dirname(stateFile);
  safeMkdir(stateDir, { recursive: true });
  const writeState = (extra: Record<string, unknown> = {}) => {
    safeWriteFile(
      stateFile,
      JSON.stringify(
        {
          pid: process.pid,
          platform,
          device: frameSource.label,
          port: handle.port,
          viewer_url: handle.viewerUrl,
          stream_url: handle.streamUrl,
          tap_enabled: Boolean(injector),
          started_at: new Date().toISOString(),
          ...handle.status(),
          ...extra,
        },
        null,
        2
      )
    );
  };
  writeState();

  const shutdown = async () => {
    writeState({ state: 'stopped', stopped_at: new Date().toISOString() });
    await handle.close();
    process.exitCode = 0;
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  setInterval(() => writeState(), 5000).unref();
}

main().catch((error: unknown) => {
  logger.error(
    `[SHARED_MOBILE] mirror-daemon failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
