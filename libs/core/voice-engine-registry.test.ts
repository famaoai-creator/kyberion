import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import {
  getVoiceEngineRecord,
  getVoiceEngineRegistry,
  resetVoiceEngineRegistryCache,
  resolveVoiceEngineForPlatform,
} from './voice-engine-registry.js';

describe('voice engine registry', () => {
  const originalPath = process.env.KYBERION_VOICE_ENGINE_REGISTRY_PATH;
  const originalDir = process.env.KYBERION_VOICE_ENGINE_REGISTRY_DIR;
  const tmpDir = pathResolver.sharedTmp('voice-engine-registry-tests');

  beforeEach(() => {
    delete process.env.KYBERION_VOICE_ENGINE_REGISTRY_PATH;
    delete process.env.KYBERION_VOICE_ENGINE_REGISTRY_DIR;
    resetVoiceEngineRegistryCache();
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.KYBERION_VOICE_ENGINE_REGISTRY_PATH;
    } else {
      process.env.KYBERION_VOICE_ENGINE_REGISTRY_PATH = originalPath;
    }
    if (originalDir === undefined) {
      delete process.env.KYBERION_VOICE_ENGINE_REGISTRY_DIR;
    } else {
      process.env.KYBERION_VOICE_ENGINE_REGISTRY_DIR = originalDir;
    }
    if (safeExistsSync(tmpDir)) {
      safeRmSync(tmpDir, { recursive: true, force: true });
    }
    resetVoiceEngineRegistryCache();
  });

  it('loads the governed registry and resolves default engine', () => {
    const registry = getVoiceEngineRegistry();
    expect(registry.default_engine_id).toBe('local_say');
    const engine = getVoiceEngineRecord();
    expect(engine.engine_id).toBe('local_say');
    expect(engine.supports.playback).toBe(true);
  });

  it('resolves active clone engine on darwin', () => {
    const engine = resolveVoiceEngineForPlatform('open_voice_clone', 'darwin');
    expect(engine.engine_id).toBe('open_voice_clone');
  });

  it('falls back to default when unknown engine id is requested', () => {
    const engine = resolveVoiceEngineForPlatform('unknown-engine', 'linux');
    expect(engine.engine_id).toBe('local_say');
  });

  it('loads the canonical directory when the default public registry is active', () => {
    safeMkdir(tmpDir, { recursive: true });
    const dir = path.join(tmpDir, 'voice-engines');
    safeMkdir(dir, { recursive: true });
    safeWriteFile(
      path.join(dir, 'local_say.json'),
      JSON.stringify({
        version: '1.0.0',
        default_engine_id: 'local_say',
        engines: [
          {
            engine_id: 'local_say',
            display_name: 'Local System TTS',
            kind: 'native_local',
            provider: 'system_tts',
            status: 'active',
            platforms: ['darwin', 'linux', 'win32'],
            supports: {
              list_voices: true,
              playback: true,
              artifact_formats: ['wav', 'aiff'],
            },
          },
        ],
      }),
    );
    safeWriteFile(
      path.join(dir, 'open_voice_clone.json'),
      JSON.stringify({
        version: '1.0.0',
        default_engine_id: 'local_say',
        engines: [
          {
            engine_id: 'open_voice_clone',
            display_name: 'Open Voice Clone',
            kind: 'voice_clone_service',
            provider: 'open_voice_clone',
            status: 'active',
            platforms: ['any'],
            supports: {
              list_voices: false,
              playback: true,
              artifact_formats: ['wav', 'aiff'],
            },
            fallback_engine_id: 'local_say',
          },
        ],
      }),
    );

    process.env.KYBERION_VOICE_ENGINE_REGISTRY_DIR = dir;
    resetVoiceEngineRegistryCache();

    const registry = getVoiceEngineRegistry();
    expect(registry.default_engine_id).toBe('local_say');
    expect(registry.engines.map((engine) => engine.engine_id)).toEqual(['local_say', 'open_voice_clone']);
  });
});
