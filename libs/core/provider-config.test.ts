import AjvModule from 'ajv';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';
import { withoutSchemaMetadata } from './test-governance-payload.js';
import { pathResolver } from './path-resolver.js';
import { describe, expect, it } from 'vitest';
import {
  isObsoleteAgentRuntimeProvider,
  loadProviderConfig,
  resolveRuntimeDefaultModelId,
} from './provider-config.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;

describe('provider-config', () => {
  it('loads runtime defaults and lifecycle defaults from the shared config', () => {
    const config = loadProviderConfig();
    expect(config.default_models.gemini).toBe('gemini-3.8-flash');
    expect(config.default_models.claude).toBe('claude-opus-5');
    expect(config.default_models.agy).toBe('Gemini 3.8 Flash (Low)');
    expect(config.default_models.codex).toBe('gpt-5.6-sol');
    expect(config.default_models.grok).toBe('grok-4.6');
    expect(config.runtime_defaults['anthropic-default']).toBe('claude-opus-5');
    expect(config.runtime_defaults['anthropic-fast']).toBe('claude-haiku-4-5-20251001');
    expect(config.default_models.copilot).toBe('auto');
    expect(config.default_models.cursor).toBe('auto');
    expect(config.default_models.opencode).toBe('opencode/muse-spark-1.3-contributor-free');
    expect(config.obsolete_agent_runtime_providers).toEqual(['gemini']);
    expect(isObsoleteAgentRuntimeProvider('gemini')).toBe(true);
    expect(isObsoleteAgentRuntimeProvider('agy')).toBe(false);
    expect(config.runtime_defaults['copilot-default']).toBe('auto');
    expect(config.runtime_defaults['cursor-default']).toBe('auto');
    expect(config.runtime_defaults['opencode-default']).toBe(
      'opencode/muse-spark-1.3-contributor-free'
    );
    expect(config.lifecycle.gemini.default_model).toBe('gemini-3.6-flash');
    expect(resolveRuntimeDefaultModelId('copilot-default')).toBe('auto');
    expect(resolveRuntimeDefaultModelId('cursor-default')).toBe('auto');
    expect(resolveRuntimeDefaultModelId('opencode-default')).toBe(
      'opencode/muse-spark-1.3-contributor-free'
    );
  });

  it('validates the provider config against the schema', () => {
    const ajv = new AjvCtor({ allErrors: true });
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.knowledge('product/schemas/provider-config.schema.json')
    );
    const config = withoutSchemaMetadata(
      JSON.parse(
        safeReadFile(pathResolver.knowledge('product/governance/provider-config.json'), {
          encoding: 'utf8',
        }) as string
      )
    );
    expect(validate(config)).toBe(true);
  });
});
