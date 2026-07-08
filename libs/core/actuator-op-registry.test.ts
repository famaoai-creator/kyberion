import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildUnknownActuatorOpError,
  determineActuatorStepType,
  listKnownActuatorOps,
  listRegisteredDomainOps,
} from './actuator-op-registry.js';
import { pathResolver, safeReadFile, safeReaddir, safeStat } from './index.js';

function collectSourceFiles(dir: string): string[] {
  const entries = safeReaddir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const abs = path.join(dir, entry);
    const stats = safeStat(abs);
    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(abs));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry.endsWith('.d.ts')) continue;
    files.push(abs);
  }
  return files;
}

describe('actuator-op-registry', () => {
  it('classifies media transform and apply ops through the shared registry', () => {
    expect(determineActuatorStepType('media', 'apply_theme')).toBe('transform');
    expect(determineActuatorStepType('media', 'merge_content')).toBe('transform');
    expect(determineActuatorStepType('media', 'document_diagram_render_from_brief')).toBe(
      'transform'
    );
    expect(determineActuatorStepType('media', 'pptx_render')).toBe('apply');
  });

  it('classifies browser and system ops through the shared registry', () => {
    expect(determineActuatorStepType('browser', 'goto')).toBe('capture');
    expect(determineActuatorStepType('browser', 'click')).toBe('apply');
    expect(determineActuatorStepType('browser', 'extension_session')).toBe('apply');
    expect(determineActuatorStepType('system', 'log')).toBe('apply');
    expect(determineActuatorStepType('system', 'voice_input_toggle')).toBe('apply');
  });

  it('prefers apply semantics when provider ops overlap', () => {
    expect(determineActuatorStepType('gemini', 'prompt')).toBe('apply');
    expect(determineActuatorStepType('gh', 'pr')).toBe('apply');
    expect(determineActuatorStepType('codex', 'exec')).toBe('apply');
  });

  it('rejects unmapped ops with an actionable UNKNOWN_OP error', () => {
    // 'stat' is a real file capture op; a truly unmapped op must throw with
    // suggestions instead of silently falling through to apply.
    expect(determineActuatorStepType('file', 'stat')).toBe('capture');
    expect(() => determineActuatorStepType('file', 'does_not_exist')).toThrow(/\[UNKNOWN_OP\]/);
  });

  it('exposes registered ops for a domain', () => {
    const mediaOps = listRegisteredDomainOps('media');
    expect(mediaOps.transform).toContain('apply_pattern');
    expect(mediaOps.apply).toContain('pptx_render');
  });

  it('builds unknown-op hints from the shared registry plus domain extras', () => {
    const message = buildUnknownActuatorOpError('network', 'ftech', ['shell']).message;
    expect(message).toContain('[UNKNOWN_OP]');
    expect(message).toContain('Did you mean: fetch');
    expect(listKnownActuatorOps('network')).toContain('fetch');
  });

  it('fails loudly for unknown ops instead of defaulting to apply', () => {
    expect(() => determineActuatorStepType('file', 'stta')).toThrowError(
      /\[UNKNOWN_OP\] Unknown op "stta" for domain "file"/
    );
  });

  it('keeps actuator sources free of silent default ctx fallthroughs', { timeout: 60_000 }, () => {
    const actuatorRoot = pathResolver.rootResolve('libs/actuators');
    const scanTargets = [
      ...collectSourceFiles(actuatorRoot),
      pathResolver.rootResolve('scripts/run_pipeline.ts'),
    ];
    const offenders = scanTargets.filter((file) =>
      String(safeReadFile(file, { encoding: 'utf8' }) || '').match(
        /default:\s*(?:return ctx;|return currentCtx;|return;)/m
      )
    );

    expect(offenders).toEqual([]);
  });
});
