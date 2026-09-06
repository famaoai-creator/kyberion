import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { projectComputerSurfaceData } from '../server.js';

const contract = {
  request_id: 'ir_computer_surface',
  normalized_intent: 'request_status',
  missing_inputs: [],
  resolution_shape: 'direct_answer',
  outcome_kind: 'status_report',
  authority_level: 'approval_required',
  next_action: {
    kind: 'request_approval',
    label: 'Approve this plan to continue.',
    consequence: 'The requested action remains waiting and does not execute without approval.',
  },
  rationale: 'surface contract test',
};

describe('Computer Surface intent resolution projection', () => {
  it('normalizes the camel and legacy snake contract keys at the A2UI boundary', () => {
    expect(
      projectComputerSurfaceData({
        status: 'running',
        intent_resolution: contract,
      })
    ).toEqual({ status: 'running', intentResolution: contract });
  });

  it('drops malformed display contracts without affecting unrelated state', () => {
    expect(
      projectComputerSurfaceData({
        status: 'running',
        intentResolution: { ...contract, authority_level: 'not-authorized' },
      })
    ).toEqual({ status: 'running' });
  });

  it('renders the full operator contract in the computer surface', () => {
    const html = String(
      safeReadFile(
        pathResolver.rootResolve('presence/displays/computer-surface/static/index.html'),
        {
          encoding: 'utf8',
        }
      )
    );
    expect(html).toContain('intent-resolution-understanding');
    expect(html).toContain('intent-resolution-missing');
    expect(html).toContain('intent-resolution-authority');
    expect(html).toContain('intent-resolution-outcome');
    expect(html).toContain('intent-resolution-next-action');
    expect(html).toContain('renderIntentResolution(data)');
  });
});
