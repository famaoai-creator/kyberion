import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';

const rootDir = process.cwd();

it('keeps cross-OS smoke on the published stance API after the customer rename', async () => {
  const workflow = String(
    safeReadFile(path.join(rootDir, '.github/workflows/cross-os.yml'), { encoding: 'utf8' })
  );
  expect(workflow).not.toMatch(/customer-resolver|activeCustomer/u);
  expect(workflow).toContain('@agent/core/stance-resolver');
  const { activeStance } = await import('@agent/core/stance-resolver');
  expect(activeStance({ KYBERION_STANCE: 'smoke-test' })).toBe('smoke-test');
});

function collectExportTargets(exportsField: any): string[] {
  const targets: string[] = [];
  if (!exportsField || typeof exportsField !== 'object') return targets;

  for (const value of Object.values(exportsField)) {
    if (typeof value === 'string') {
      targets.push(value);
      continue;
    }
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) {
        if (typeof nested === 'string') {
          targets.push(nested);
        }
      }
    }
  }
  return targets;
}

describe('Workspace build contract', () => {
  it('keeps CI-built workspace package entrypoints aligned with built output files', () => {
    const packageFiles = [
      'libs/core/package.json',
      'libs/shared-voice/package.json',
      'libs/shared-mobile/package.json',
      'libs/shared-media/package.json',
      'libs/shared-perception/package.json',
    ];

    const missing: string[] = [];

    for (const relPkg of packageFiles) {
      const absPkg = path.join(rootDir, relPkg);
      const pkgDir = path.dirname(absPkg);
      const pkg = JSON.parse(safeReadFile(absPkg, { encoding: 'utf8' }) as string);
      const targets = [pkg.main, pkg.types, ...collectExportTargets(pkg.exports)].filter(
        (value: unknown): value is string => typeof value === 'string'
      );

      for (const target of targets) {
        const resolved = path.resolve(pkgDir, target);
        if (!safeExistsSync(resolved)) {
          missing.push(`${relPkg} -> ${target}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('keeps Set-of-Marks rendering in shared-perception with its vision consumer', () => {
    const root = JSON.parse(
      safeReadFile(path.join(rootDir, 'package.json'), { encoding: 'utf8' }) as string
    );
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    const perception = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-perception/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    const vision = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/actuators/vision-actuator/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(core.exports['./som-overlay']).toBeUndefined();
    expect(safeExistsSync(path.join(rootDir, 'libs/core/som-overlay.ts'))).toBe(false);
    expect(perception.exports['./som-overlay']).toEqual({
      types: './dist/som-overlay.d.ts',
      default: './dist/som-overlay.js',
    });
    expect(perception.dependencies.jimp).toBe(root.dependencies.jimp);
    expect(vision.dependencies['@agent/shared-perception']).toBe('workspace:*');
    // Screen redaction, secure I/O, mark contracts, and image hashing stay
    // shared in core; moving the renderer must not reverse that dependency.
    for (const subpath of [
      './virtual/screen-frame-redaction',
      './secure-io',
      './set-of-marks',
      './media/image-dhash',
    ]) {
      expect(core.exports[subpath]).toBeDefined();
    }
  });

  it('keeps mark target resolution in shared-perception with its actuator consumers', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    const perception = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-perception/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(core.exports['./mark-target-resolver']).toBeUndefined();
    expect(safeExistsSync(path.join(rootDir, 'libs/core/mark-target-resolver.ts'))).toBe(false);
    expect(perception.exports['./mark-target-resolver']).toEqual({
      types: './dist/mark-target-resolver.d.ts',
      default: './dist/mark-target-resolver.js',
    });
    for (const actuator of ['browser', 'system', 'vision']) {
      const manifest = JSON.parse(
        safeReadFile(path.join(rootDir, `libs/actuators/${actuator}-actuator/package.json`), {
          encoding: 'utf8',
        }) as string
      );
      expect(manifest.dependencies['@agent/shared-perception']).toBe('workspace:*');
    }
    // Mission lookup, scoped I/O, mark contracts, and hashing retain their
    // canonical core implementations and do not depend on shared-perception.
    for (const subpath of [
      './foundation/safe-json',
      './foundation/json',
      './path-resolver',
      './secure-io',
      './set-of-marks',
      './media/image-dhash',
    ]) {
      expect(core.exports[subpath]).toBeDefined();
    }
    expect(core.dependencies?.['@agent/shared-perception']).toBeUndefined();
  });

  it('keeps host image hand-off bookkeeping with its shared-media consumers', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    const media = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-media/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(core.exports['./host-image-handoff']).toBeUndefined();
    expect(safeExistsSync(path.join(rootDir, 'libs/core/host-image-handoff.ts'))).toBe(false);
    expect(media.exports['./host-image-handoff']).toEqual({
      types: './dist/host-image-handoff.d.ts',
      default: './dist/host-image-handoff.js',
    });
    // Persistence, path resolution, and security remain in core. Only the
    // image-specific bookkeeping module moves beside its consumers.
    for (const subpath of ['./foundation/json', './path-resolver', './secure-io']) {
      expect(core.exports[subpath]).toBeDefined();
    }
  });

  it('keeps media policy and visual compilation leaves beside their consumers', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    const media = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-media/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    for (const name of [
      'deck-theme-direction',
      'legacy-media-ops',
      'spreadsheet-style-policy',
      'tracker-sheet-policy',
      'visual-workflow-compiler',
      'windows-native-image-generation-bridge',
    ]) {
      expect(core.exports[`./${name}`]).toBeUndefined();
      expect(media.exports[`./${name}`]).toEqual({
        types: `./dist/${name}.d.ts`,
        default: `./dist/${name}.js`,
      });
      for (const suffix of ['.ts', '.test.ts']) {
        expect(safeExistsSync(path.join(rootDir, `libs/core/${name}${suffix}`))).toBe(false);
        expect(safeExistsSync(path.join(rootDir, `libs/shared-media/src/${name}${suffix}`))).toBe(
          true
        );
      }
      for (const suffix of ['.js', '.d.ts', '.js.map', '.d.ts.map']) {
        expect(safeExistsSync(path.join(rootDir, `libs/core/dist/${name}${suffix}`))).toBe(false);
        expect(safeExistsSync(path.join(rootDir, `libs/shared-media/dist/${name}${suffix}`))).toBe(
          true
        );
      }
    }
    for (const actuator of ['media', 'media-generation']) {
      const manifest = JSON.parse(
        safeReadFile(path.join(rootDir, `libs/actuators/${actuator}-actuator/package.json`), {
          encoding: 'utf8',
        }) as string
      );
      expect(manifest.dependencies['@agent/shared-media']).toBe('workspace:*');
    }
    for (const subpath of [
      './logger',
      './foundation/locale-normalize',
      './foundation/safe-json',
      './json-repair',
      './reasoning/reasoning-backend',
      './path-resolver',
      './foundation/governed-catalog',
      './secure-io',
      './contracts/image-generation-adf',
      './contracts/video-generation-adf',
      './foundation/text',
      './video/video-design-system',
    ]) {
      expect(core.exports[subpath]).toBeDefined();
    }
    expect(media.dependencies['@agent/core']).toBe('workspace:*');
    expect(core.dependencies?.['@agent/shared-media']).toBeUndefined();
  });

  it('keeps mobile runtime helpers in shared-mobile without closing legacy deep imports', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    const mobile = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-mobile/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(core.exports['./mobile-runtime-helpers']).toBeUndefined();
    expect(core.exports['./mobile-profile-validators']).toBeDefined();
    expect(core.exports['./types']).toBeDefined();
    expect(core.exports['./secure-io']).toBeDefined();
    expect(mobile.exports).toBeUndefined();
    expect(safeExistsSync(path.join(rootDir, 'libs/core/mobile-runtime-helpers.ts'))).toBe(false);
    for (const filename of ['mobile-runtime-helpers.js', 'mobile-runtime-helpers.d.ts']) {
      expect(safeExistsSync(path.join(rootDir, 'libs/shared-mobile/dist', filename))).toBe(true);
    }
  });

  it('keeps two-stage barge-in in shared-voice and the shared energy detector in core', () => {
    const readPackage = (directory: string) =>
      JSON.parse(
        safeReadFile(path.join(rootDir, directory, 'package.json'), { encoding: 'utf8' }) as string
      ) as { exports: Record<string, { types: string; default: string }> };
    const core = readPackage('libs/core');
    const voice = readPackage('libs/shared-voice');

    expect(core.exports['./two-stage-barge-in']).toBeUndefined();
    expect(safeExistsSync(path.join(rootDir, 'libs/core/two-stage-barge-in.ts'))).toBe(false);
    expect(voice.exports['./two-stage-barge-in']).toEqual({
      types: './dist/two-stage-barge-in.d.ts',
      default: './dist/two-stage-barge-in.js',
    });
    // Meeting and voice both use the energy detector, so it must not move
    // into a package that would make core depend on shared-voice.
    expect(core.exports['./barge-in-controller']).toEqual({
      types: './dist/barge-in-controller.d.ts',
      default: './dist/barge-in-controller.js',
    });
  });

  it('keeps the TEN VAD bridge in shared-voice beside the other VAD installers', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    const voice = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-voice/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(core.exports['./ten-vad-bridge']).toBeUndefined();
    expect(safeExistsSync(path.join(rootDir, 'libs/core/ten-vad-bridge.ts'))).toBe(false);
    expect(voice.exports['./ten-vad-bridge']).toEqual({
      types: './dist/ten-vad-bridge.d.ts',
      default: './dist/ten-vad-bridge.js',
    });
    // The VAD registry, bridge protocol, and detector contract stay in core;
    // only the optional TEN backend installer moved.
    for (const subpath of [
      './voice/vad-registry',
      './voice/vad-bridge-protocol',
      './voice/voice-activity-detector',
      './meeting/meeting-session-types',
    ]) {
      expect(core.exports[subpath]).toBeDefined();
    }
  });

  it('keeps bridge error replies in shared-interaction with its satellite consumers', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    const interaction = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-interaction/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(core.exports['./bridge-error-reply']).toBeUndefined();
    expect(safeExistsSync(path.join(rootDir, 'libs/core/bridge-error-reply.ts'))).toBe(false);
    expect(interaction.exports['./bridge-error-reply']).toEqual({
      types: './dist/bridge-error-reply.d.ts',
      default: './dist/bridge-error-reply.js',
    });
    for (const satellite of [
      'discord-bridge',
      'imessage-bridge',
      'slack-bridge',
      'telegram-bridge',
    ]) {
      const manifest = JSON.parse(
        safeReadFile(path.join(rootDir, `satellites/${satellite}/package.json`), {
          encoding: 'utf8',
        }) as string
      );
      expect(manifest.dependencies['@agent/shared-interaction']).toBe('workspace:*');
    }
    // Error classification, vocabulary rendering, rate limiting, and runtime
    // control policy stay in core; only the presentation helpers moved.
    for (const subpath of [
      './error-classifier',
      './ux-vocabulary',
      './foundation/rate-limit',
      './runtime-control-policy',
    ]) {
      expect(core.exports[subpath]).toBeDefined();
    }
  });

  it('keeps segmented voice playback in shared-voice with its realtime loop consumer', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    const voice = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-voice/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(core.exports['./segmented-voice-playback']).toBeUndefined();
    expect(safeExistsSync(path.join(rootDir, 'libs/core/segmented-voice-playback.ts'))).toBe(false);
    expect(voice.exports['./segmented-voice-playback']).toEqual({
      types: './dist/segmented-voice-playback.d.ts',
      default: './dist/segmented-voice-playback.js',
    });
    // Playback, text chunking, and the streaming gate stay in core; only the
    // segmenter moved beside its sole consumer.
    for (const subpath of [
      './voice/audio-playback',
      './voice/voice-text-chunking',
      './streaming-voice-playback',
    ]) {
      expect(core.exports[subpath]).toBeDefined();
    }
  });

  it('keeps the MCP request context in shared-network with its facade consumers', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    expect(core.exports['./mcp-request-context']).toBeUndefined();
    expect(safeExistsSync(path.join(rootDir, 'libs/core/mcp-request-context.ts'))).toBe(false);
    expect(
      safeExistsSync(path.join(rootDir, 'libs/shared-network/src/mcp-request-context.ts'))
    ).toBe(true);
    const network = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-network/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(network.exports['./mcp-request-context']).toEqual({
      types: './dist/mcp-request-context.d.ts',
      default: './dist/mcp-request-context.js',
    });
    // The NHI claim resolver stays in core and is now a published subpath so
    // shared-network can reach it; event scope and the env registry remain
    // public core services.
    for (const subpath of ['./contracts/nhi-id', './event-scope', './foundation/env']) {
      expect(core.exports[subpath]).toBeDefined();
    }
  });

  it('keeps the Cowork cluster in shared-network beside its MCP engine consumer', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    for (const name of [
      'cowork-artifact-packet',
      'cowork-health-check',
      'cowork-knowledge-bridge',
      'cowork-surface',
    ]) {
      for (const subpath of [`./${name}`, `./${name}.js`]) {
        expect(core.exports[subpath]).toBeUndefined();
      }
      for (const suffix of ['.ts', '.test.ts']) {
        expect(safeExistsSync(path.join(rootDir, `libs/core/${name}${suffix}`))).toBe(false);
        expect(safeExistsSync(path.join(rootDir, `libs/shared-network/src/${name}${suffix}`))).toBe(
          true
        );
      }
      for (const suffix of ['.js', '.d.ts', '.js.map', '.d.ts.map']) {
        expect(safeExistsSync(path.join(rootDir, `libs/core/dist/${name}${suffix}`))).toBe(false);
        expect(
          safeExistsSync(path.join(rootDir, `libs/shared-network/dist/${name}${suffix}`))
        ).toBe(true);
      }
      const network = JSON.parse(
        safeReadFile(path.join(rootDir, 'libs/shared-network/package.json'), {
          encoding: 'utf8',
        }) as string
      );
      expect(network.exports[`./${name}`]).toEqual({
        types: `./dist/${name}.d.ts`,
        default: `./dist/${name}.js`,
      });
    }
    // The governed approval adapter, artifact store, memory promotion queue,
    // and scope plumbing stay in core; only the Cowork-facing modules moved.
    for (const subpath of [
      './governance/approval-cowork-adapter',
      './workforce/artifact-store',
      './knowledge/memory-promotion-queue',
      './knowledge/memory-scope',
      './scope-context',
      './physical-namespace',
      './intent/intent-resolution-contract',
    ]) {
      expect(core.exports[subpath]).toBeDefined();
    }
  });

  it('keeps the Silero VAD bridge in shared-voice beside the TEN backend', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    const voice = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-voice/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(core.exports['./silero-vad-bridge']).toBeUndefined();
    for (const suffix of ['.ts', '.test.ts']) {
      expect(safeExistsSync(path.join(rootDir, `libs/core/silero-vad-bridge${suffix}`))).toBe(
        false
      );
      expect(
        safeExistsSync(path.join(rootDir, `libs/shared-voice/src/silero-vad-bridge${suffix}`))
      ).toBe(true);
    }
    for (const suffix of ['.js', '.d.ts', '.js.map', '.d.ts.map']) {
      expect(safeExistsSync(path.join(rootDir, `libs/core/dist/silero-vad-bridge${suffix}`))).toBe(
        false
      );
      expect(
        safeExistsSync(path.join(rootDir, `libs/shared-voice/dist/silero-vad-bridge${suffix}`))
      ).toBe(true);
    }
    expect(voice.exports['./silero-vad-bridge']).toEqual({
      types: './dist/silero-vad-bridge.d.ts',
      default: './dist/silero-vad-bridge.js',
    });
    // The VAD registry/protocol/detector contracts, secure exec env, path
    // resolution, and managed-tool runtime stay in core; only the Silero
    // backend moved. The Python bridge script stays with voice-actuator.
    for (const subpath of [
      './voice/vad-registry',
      './voice/vad-bridge-protocol',
      './voice/voice-activity-detector',
      './secure-io',
      './path-resolver',
      './tool/tool-runtime-registry',
      './meeting/meeting-session-types',
    ]) {
      expect(core.exports[subpath]).toBeDefined();
    }
  });

  it('keeps the BlackHole routing guard beside its pipeline-execution consumers', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    expect(core.exports['./blackhole-routing-guard']).toBeUndefined();
    expect(safeExistsSync(path.join(rootDir, 'libs/core/blackhole-routing-guard.ts'))).toBe(false);
    expect(safeExistsSync(path.join(rootDir, 'scripts/lib/blackhole-routing-guard.ts'))).toBe(true);
  });

  it('keeps the Apple speech file STT bridge in shared-voice with the VAD backends', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    const voice = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-voice/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(core.exports['./apple-speech-file-stt-bridge']).toBeUndefined();
    for (const suffix of ['.ts', '.test.ts']) {
      expect(
        safeExistsSync(path.join(rootDir, `libs/core/apple-speech-file-stt-bridge${suffix}`))
      ).toBe(false);
      expect(
        safeExistsSync(
          path.join(rootDir, `libs/shared-voice/src/apple-speech-file-stt-bridge${suffix}`)
        )
      ).toBe(true);
    }
    for (const suffix of ['.js', '.d.ts', '.js.map', '.d.ts.map']) {
      expect(
        safeExistsSync(path.join(rootDir, `libs/core/dist/apple-speech-file-stt-bridge${suffix}`))
      ).toBe(false);
      expect(
        safeExistsSync(
          path.join(rootDir, `libs/shared-voice/dist/apple-speech-file-stt-bridge${suffix}`)
        )
      ).toBe(true);
    }
    expect(voice.exports['./apple-speech-file-stt-bridge']).toEqual({
      types: './dist/apple-speech-file-stt-bridge.d.ts',
      default: './dist/apple-speech-file-stt-bridge.js',
    });
    // The STT seam contract, local backend discovery, locale/env plumbing,
    // and secure exec stay in core; only the Apple Speech backend moved.
    for (const subpath of [
      './voice/speech-to-text-bridge',
      './local-stt-discovery',
      './locale',
      './foundation/env',
      './secure-io',
      './path-resolver',
    ]) {
      expect(core.exports[subpath]).toBeDefined();
    }
  });

  it('keeps the OBS virtual-camera output in shared-video with its filter provider', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    const video = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-video/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(core.exports['./obs-virtual-camera-output']).toBeUndefined();
    for (const suffix of ['.ts', '.test.ts']) {
      expect(
        safeExistsSync(path.join(rootDir, `libs/core/obs-virtual-camera-output${suffix}`))
      ).toBe(false);
      expect(
        safeExistsSync(
          path.join(rootDir, `libs/shared-video/src/obs-virtual-camera-output${suffix}`)
        )
      ).toBe(true);
    }
    for (const suffix of ['.js', '.d.ts', '.js.map', '.d.ts.map']) {
      expect(
        safeExistsSync(path.join(rootDir, `libs/core/dist/obs-virtual-camera-output${suffix}`))
      ).toBe(false);
      expect(
        safeExistsSync(
          path.join(rootDir, `libs/shared-video/dist/obs-virtual-camera-output${suffix}`)
        )
      ).toBe(true);
    }
    expect(video.exports['./obs-virtual-camera-output']).toEqual({
      types: './dist/obs-virtual-camera-output.d.ts',
      default: './dist/obs-virtual-camera-output.js',
    });
    const actuator = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/actuators/voice-actuator/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(actuator.dependencies['@agent/shared-video']).toBe('workspace:*');
    // The camera-output seam contract and env registry stay in core; only the
    // OBS backend moved.
    for (const subpath of ['./camera-output-bridge', './foundation/env', './video/video-route']) {
      expect(core.exports[subpath]).toBeDefined();
    }
  });

  it('keeps the v4l2 virtual-camera output in shared-video with the OBS backend', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    const video = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-video/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(core.exports['./v4l2-virtual-camera-output']).toBeUndefined();
    for (const suffix of ['.ts', '.test.ts']) {
      expect(
        safeExistsSync(path.join(rootDir, `libs/core/v4l2-virtual-camera-output${suffix}`))
      ).toBe(false);
      expect(
        safeExistsSync(
          path.join(rootDir, `libs/shared-video/src/v4l2-virtual-camera-output${suffix}`)
        )
      ).toBe(true);
    }
    for (const suffix of ['.js', '.d.ts', '.js.map', '.d.ts.map']) {
      expect(
        safeExistsSync(path.join(rootDir, `libs/core/dist/v4l2-virtual-camera-output${suffix}`))
      ).toBe(false);
      expect(
        safeExistsSync(
          path.join(rootDir, `libs/shared-video/dist/v4l2-virtual-camera-output${suffix}`)
        )
      ).toBe(true);
    }
    expect(video.exports['./v4l2-virtual-camera-output']).toEqual({
      types: './dist/v4l2-virtual-camera-output.d.ts',
      default: './dist/v4l2-virtual-camera-output.js',
    });
    // The seam contract, the governed injection bridge the adapter wraps, the
    // device lease, and exec/path plumbing stay in core; only the v4l2 adapter
    // moved.
    for (const subpath of [
      './camera-output-bridge',
      './virtual/virtual-camera-injection-bridge',
      './secure-io',
      './video/video-device-lease',
      './video/video-route',
    ]) {
      expect(core.exports[subpath]).toBeDefined();
    }
  });

  it('keeps the desktop AX bridge in shared-perception with its system-actuator consumer', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    const perception = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-perception/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(core.exports['./desktop-ax-bridge']).toBeUndefined();
    expect(safeExistsSync(path.join(rootDir, 'libs/core/desktop-ax-bridge.ts'))).toBe(false);
    expect(perception.exports['./desktop-ax-bridge']).toEqual({
      types: './dist/desktop-ax-bridge.d.ts',
      default: './dist/desktop-ax-bridge.js',
    });
    const system = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/actuators/system-actuator/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(system.dependencies['@agent/shared-perception']).toBe('workspace:*');
    // Path resolution, scoped I/O, and managed-tool resolution remain in
    // core; moving the AX bridge must not reverse that dependency.
    for (const subpath of [
      './path-resolver',
      './secure-io',
      './foundation/runtime-state-roots',
      './tool/tool-binary-resolvers',
    ]) {
      expect(core.exports[subpath]).toBeDefined();
    }
    expect(core.dependencies?.['@agent/shared-perception']).toBeUndefined();
  });
});
