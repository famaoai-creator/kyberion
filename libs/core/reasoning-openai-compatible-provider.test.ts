import { afterEach, describe, expect, it } from 'vitest';
import { buildOpenAiCompatibleProviderBundle } from './reasoning-openai-compatible-provider.js';

const saved = {
  url: process.env.KYBERION_LOCAL_LLM_URL,
  key: process.env.KYBERION_LOCAL_LLM_KEY,
  model: process.env.KYBERION_LOCAL_LLM_MODEL,
};

afterEach(() => {
  if (saved.url === undefined) delete process.env.KYBERION_LOCAL_LLM_URL;
  else process.env.KYBERION_LOCAL_LLM_URL = saved.url;
  if (saved.key === undefined) delete process.env.KYBERION_LOCAL_LLM_KEY;
  else process.env.KYBERION_LOCAL_LLM_KEY = saved.key;
  if (saved.model === undefined) delete process.env.KYBERION_LOCAL_LLM_MODEL;
  else process.env.KYBERION_LOCAL_LLM_MODEL = saved.model;
});

describe('OpenAI-compatible reasoning provider module', () => {
  it('resolves the local family through one provider module', () => {
    process.env.KYBERION_LOCAL_LLM_URL = 'http://127.0.0.1:9999/v1';
    process.env.KYBERION_LOCAL_LLM_KEY = 'test-key';
    process.env.KYBERION_LOCAL_LLM_MODEL = 'test-model';

    const bundle = buildOpenAiCompatibleProviderBundle({
      mode: 'local',
      provider: 'local',
      overrides: { model: 'override-model' },
    });
    expect(bundle).toMatchObject({
      mode: 'local',
      backend: { provider: 'local', label: 'local' },
    });
  });

  it('returns undefined for modes owned by another provider module', () => {
    expect(
      buildOpenAiCompatibleProviderBundle({
        mode: 'anthropic',
        provider: 'anthropic',
        overrides: {},
      })
    ).toBeUndefined();
  });

  it('returns null for a governed family mode without a configured endpoint', () => {
    delete process.env.KYBERION_LOCAL_LLM_URL;
    delete process.env.KYBERION_LOCAL_LLM_KEY;
    expect(
      buildOpenAiCompatibleProviderBundle({
        mode: 'local',
        provider: 'local',
        overrides: {},
      })
    ).toBeNull();
  });
});
