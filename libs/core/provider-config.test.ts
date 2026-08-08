import AjvModule from 'ajv';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { describe, expect, it } from 'vitest';
import { loadProviderConfig, resolveRuntimeDefaultModelId } from './provider-config.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;

describe('provider-config', () => {
  it('loads runtime defaults and lifecycle defaults from the shared config', () => {
    const config = loadProviderConfig();
    expect(config.default_models.gemini).toBe('gemini-3.6-flash');
    expect(config.default_models.claude).toBe('claude-opus-4-8');
    expect(config.default_models.agy).toBe('Gemini 3.6 Flash (Medium)');
    expect(config.default_models.codex).toBe('gpt-5.6-sol');
    expect(config.runtime_defaults['anthropic-default']).toBe('claude-opus-4-8');
    expect(config.runtime_defaults['anthropic-fast']).toBe('claude-haiku-4-5-20251001');
    expect(config.default_models.copilot).toBe('auto');
    expect(config.runtime_defaults['copilot-default']).toBe('auto');
    expect(config.lifecycle.gemini.default_model).toBe('gemini-3.6-flash');
    expect(resolveRuntimeDefaultModelId('copilot-default')).toBe('auto');
  });

  it('validates the provider config against the schema', () => {
    const ajv = new AjvCtor({ allErrors: true });
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.knowledge('product/schemas/provider-config.schema.json')
    );
    const config = JSON.parse(
      safeReadFile(pathResolver.knowledge('product/governance/provider-config.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(validate(config)).toBe(true);
  });
});
