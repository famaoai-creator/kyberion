import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getVoiceEngineRecord,
  getVoiceEngineRegistry,
  resetVoiceEngineRegistryCache,
  resolveVoiceEngineForPlatform,
} from './voice-engine-registry.js';

describe('voice engine registry', () => {
  const originalPath = process.env.KYBERION_VOICE_ENGINE_REGISTRY_PATH;

  beforeEach(() => {
    delete process.env.KYBERION_VOICE_ENGINE_REGISTRY_PATH;
    resetVoiceEngineRegistryCache();
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.KYBERION_VOICE_ENGINE_REGISTRY_PATH;
    } else {
      process.env.KYBERION_VOICE_ENGINE_REGISTRY_PATH = originalPath;
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
});
