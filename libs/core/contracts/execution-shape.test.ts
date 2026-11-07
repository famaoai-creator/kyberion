import { describe, expect, it } from 'vitest';
import {
  normalizeExecutionShape,
  projectExecutionShapeToWorkflowShape,
} from './execution-shape.js';

describe('execution-shape', () => {
  it('normalizes known routing and workflow shapes without widening', () => {
    expect(normalizeExecutionShape(' browser_session ')).toBe('browser_session');
    expect(normalizeExecutionShape('ACTUATOR_ACTION')).toBe('actuator_action');
    expect(normalizeExecutionShape('pipeline')).toBe('pipeline');
    expect(normalizeExecutionShape('task_session')).toBe('task_session');
  });

  it('falls back to task_session for unknown shapes', () => {
    expect(normalizeExecutionShape('unknown-shape')).toBe('task_session');
  });

  it('projects routing shapes into workflow shapes while preserving pipeline', () => {
    expect(projectExecutionShapeToWorkflowShape('direct_reply')).toBe('direct_reply');
    expect(projectExecutionShapeToWorkflowShape('browser_session')).toBe('task_session');
    expect(projectExecutionShapeToWorkflowShape('actuator_action')).toBe('task_session');
    expect(projectExecutionShapeToWorkflowShape('pipeline')).toBe('pipeline');
    expect(projectExecutionShapeToWorkflowShape('mission')).toBe('mission');
    expect(projectExecutionShapeToWorkflowShape('project_bootstrap')).toBe('project_bootstrap');
  });
});
