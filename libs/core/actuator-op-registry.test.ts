import { describe, expect, it } from 'vitest';
import { determineActuatorStepType, listRegisteredDomainOps } from './actuator-op-registry.js';

describe('actuator-op-registry', () => {
  it('classifies media transform and apply ops through the shared registry', () => {
    expect(determineActuatorStepType('media', 'apply_theme')).toBe('transform');
    expect(determineActuatorStepType('media', 'merge_content')).toBe('transform');
    expect(determineActuatorStepType('media', 'document_diagram_render_from_brief')).toBe('transform');
    expect(determineActuatorStepType('media', 'pptx_render')).toBe('apply');
  });

  it('classifies browser and system ops through the shared registry', () => {
    expect(determineActuatorStepType('browser', 'goto')).toBe('capture');
    expect(determineActuatorStepType('browser', 'click')).toBe('apply');
    expect(determineActuatorStepType('system', 'log')).toBe('apply');
    expect(determineActuatorStepType('system', 'voice_input_toggle')).toBe('apply');
  });

  it('prefers apply semantics when provider ops overlap', () => {
    expect(determineActuatorStepType('gemini', 'prompt')).toBe('apply');
    expect(determineActuatorStepType('gh', 'pr')).toBe('apply');
    expect(determineActuatorStepType('codex', 'exec')).toBe('apply');
  });

  it('exposes registered ops for a domain', () => {
    const mediaOps = listRegisteredDomainOps('media');
    expect(mediaOps.transform).toContain('apply_pattern');
    expect(mediaOps.apply).toContain('pptx_render');
  });
});
