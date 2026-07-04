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
    expect(config.default_models.gemini).toBe('gemini-3.5-flash');
    expect(config.default_models.claude).toBe('claude-opus-4-8');
    expect(config.default_models.codex).toBe('gpt-5.5');
    expect(config.default_models.copilot).toBe('claude-sonnet-4-6');
    expect(config.runtime_defaults['copilot-default']).toBe('claude-sonnet-4-6');
    expect(config.lifecycle.gemini.default_model).toBe('gemini-3.5-flash');
    expect(resolveRuntimeDefaultModelId('copilot-default')).toBe('claude-sonnet-4-6');
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
