import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildUnknownActuatorOpError,
  determineActuatorStepType,
  listKnownActuatorOps,
  listRegisteredDomainOps,
  resolveActuatorOperation,
  resolveActuatorOperationTimeout,
  resolveActuatorModulePath,
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
    expect(determineActuatorStepType('media', 'document_diagram_render_from_brief')).toBe('apply');
    expect(determineActuatorStepType('media', 'pptx_layout_preflight')).toBe('transform');
    expect(determineActuatorStepType('media', 'pptx_render')).toBe('apply');
  });

  it('classifies browser and system ops through the shared registry', () => {
    expect(determineActuatorStepType('browser', 'goto')).toBe('capture');
    expect(determineActuatorStepType('browser', 'click')).toBe('apply');
    expect(determineActuatorStepType('browser', 'extension_session')).toBe('apply');
    expect(determineActuatorStepType('system', 'log')).toBe('apply');
    expect(determineActuatorStepType('system', 'voice_input_toggle')).toBe('apply');
  });

  it('classifies every built-in core leaf op from the core registry domain', () => {
    const captureOps = [
      'run_first_win_lifecycle',
      'run_health_degradation_watch',
      'run_tenant_drift_watch',
      'run_ui_ux_governance',
      'run_vitest',
    ];
    const transformOps = ['calculate_productivity_score', 'parse_proposal_brief', 'transform'];
    const applyOps = [
      'apply_onboarding',
      'capture_avatar_photo',
      'generate_avatar',
      'grant_voice_consent',
      'programmatic_tool_call',
      'ptc',
      'register_avatar',
      'run_ai_audit',
      'run_auto_checkpoint',
      'run_backup_create',
      'run_backup_restore_drill',
      'run_campaign_suite',
      'run_catalog_integrity',
      'run_compliance_scan',
      'run_dependency_vulnerability_scan',
      'run_doc_examples_check',
      'run_i18n_hardcoding',
      'run_marketing_video_dry_run',
      'run_mesh_delivery',
      'run_mission_create',
      'run_mission_start_from_issues',
      'run_oauth_setup',
      'run_pipeline',
      'run_promote_procedure',
      'run_registry_manager',
      'run_software_quality_report',
      'run_soak_endurance',
      'run_soak_restart_e2e',
      'run_translation_coverage',
      'validate_productivity_dry_run',
      'wait',
    ];
    expect(captureOps).toHaveLength(5);
    expect(transformOps).toHaveLength(3);
    expect(applyOps).toHaveLength(31);
    for (const op of captureOps) expect(determineActuatorStepType('core', op)).toBe('capture');
    for (const op of transformOps) expect(determineActuatorStepType('core', op)).toBe('transform');
    for (const op of applyOps) expect(determineActuatorStepType('core', op)).toBe('apply');
    const registeredCoreOps = listRegisteredDomainOps('core');
    expect([
      ...(registeredCoreOps.capture || []),
      ...(registeredCoreOps.transform || []),
      ...(registeredCoreOps.apply || []),
    ]).toHaveLength(39);
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
    expect(mediaOps.transform).toContain('pptx_layout_preflight');
    expect(mediaOps.apply).toContain('pptx_render');
  });

  it('builds unknown-op hints from the shared registry plus domain extras', () => {
    const message = buildUnknownActuatorOpError('network', 'ftech', ['shell']).message;
    expect(message).toContain('[UNKNOWN_OP]');
    expect(message).toContain('Did you mean: fetch');
    expect(listKnownActuatorOps('network')).toContain('fetch');
  });

  it('resolves a registered operation with actuator provenance', () => {
    const resolved = resolveActuatorOperation('service', 'api');
    expect(resolved).toMatchObject({
      domain: 'service',
      action: 'api',
      actuatorId: 'service-actuator',
      stepType: 'apply',
      source: 'actuator-op-registry',
      manifestPath: 'libs/actuators/service-actuator/manifest.json',
    });
    expect(resolved?.modulePath).toBe('dist/libs/actuators/service-actuator/src/index.js');
  });

  it('derives the dispatch module from the manifest entrypoint', () => {
    const resolved = resolveActuatorOperation('video-composition', 'prepare_video_composition');
    expect(resolved).toMatchObject({
      actuatorId: 'video-composition-actuator',
      manifestPath: 'libs/actuators/video-composition-actuator/manifest.json',
      modulePath: 'dist/libs/actuators/video-composition-actuator/src/index.js',
    });
  });

  it('resolves governed operation budgets without importing the actuator', () => {
    expect(resolveActuatorOperationTimeout('system', 'exec')).toBe(120000);
    expect(resolveActuatorOperation('system', 'exec')).toMatchObject({ timeoutMs: 120000 });
  });

  it('rejects manifest entrypoints that could escape the actuator directory', () => {
    expect(resolveActuatorModulePath('service-actuator', 'src/index.ts')).toBe(
      'dist/libs/actuators/service-actuator/src/index.js'
    );
    expect(() => resolveActuatorModulePath('service-actuator', '../shared.js')).toThrow(
      '[OP_RESOLUTION_MANIFEST]'
    );
    expect(() => resolveActuatorModulePath('service-actuator', '/tmp/escape.js')).toThrow(
      '[OP_RESOLUTION_MANIFEST]'
    );
    expect(() => resolveActuatorModulePath('../outside', 'src/index.js')).toThrow(
      '[OP_RESOLUTION_MANIFEST]'
    );
    expect(() => resolveActuatorModulePath('nested/actuator', 'src/index.js')).toThrow(
      '[OP_RESOLUTION_MANIFEST]'
    );
    expect(() => resolveActuatorModulePath('nested\\actuator', 'src/index.js')).toThrow(
      '[OP_RESOLUTION_MANIFEST]'
    );
  });

  it('fails loudly for unknown ops instead of defaulting to apply', () => {
    expect(() => determineActuatorStepType('file', 'stta')).toThrowError(
      /\[UNKNOWN_OP\] Unknown op "stta" for domain "file"/
    );
  });

  // The secure-I/O guarded recursive scan is intentionally broader than a
  // unit-level fixture.  Under the parallel CI workers it can take several
  // times longer than on a developer machine, so keep the guard generous
  // enough to detect a real hang without making normal CI load flaky.
  it('keeps actuator sources free of silent default ctx fallthroughs', { timeout: 180_000 }, () => {
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
