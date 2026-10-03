import { describe, expect, it } from 'vitest';
import {
  lookupOpCapability,
  resolveCapabilityEffect,
  resolveCapabilityEgressDestination,
  resolveCapabilityResourceRef,
  resetOpCapabilityIndex,
} from './actuator-manifest-index.js';

describe('manifest step_ops', () => {
  const resolve = (op: string, input: Record<string, unknown> = {}) => {
    resetOpCapabilityIndex();
    const capability = lookupOpCapability(op);
    return {
      capability,
      effect: capability ? resolveCapabilityEffect(capability, input) : 'write',
      ref: capability ? resolveCapabilityResourceRef(capability, input) : undefined,
      destination: capability ? resolveCapabilityEgressDestination(capability, input) : undefined,
    };
  };

  it('resolves pipeline step ops that were previously unresolvable', () => {
    expect(resolve('system:write_file', { path: 'out/a.md' })).toMatchObject({
      effect: 'write',
      ref: 'out/a.md',
    });
    expect(resolve('system:read_file', { path: 'in/a.md' })).toMatchObject({
      effect: 'read',
      ref: 'in/a.md',
    });
    expect(resolve('system:log')).toMatchObject({ effect: 'none' });
  });

  it('resolves verified read-only media and modeling steps, and keeps the rest write', () => {
    expect(resolve('modeling:read_json', { path: 'package.json' })).toMatchObject({
      effect: 'read',
      ref: 'package.json',
    });
    expect(resolve('media:document_digest', { path: 'in/a.pdf' })).toMatchObject({
      effect: 'read',
      ref: 'in/a.pdf',
    });
    // pptx_extract writes its assets to scratch: not declared read.
    expect(resolve('media:pptx_extract', { path: 'in/a.pptx' }).effect).toBe('write');
  });

  it('declares the destination of a navigating step as egress', () => {
    expect(resolve('browser:goto', { url: 'https://example.com/a' })).toMatchObject({
      effect: 'egress',
      destination: 'https://example.com/a',
    });
    expect(resolve('browser:snapshot')).toMatchObject({ effect: 'read' });
  });

  it('keeps fail-safe write for a step nobody declared', () => {
    expect(resolve('system:totally_unknown_step').effect).toBe('write');
  });

  it('never lets a step op shadow a declared capability', () => {
    const { capability } = resolve('service:api');
    expect(capability?.op).toBe('api');
    expect(capability?.step_ops).toBeUndefined();
  });
});
