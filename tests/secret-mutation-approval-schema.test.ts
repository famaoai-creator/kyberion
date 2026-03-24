import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';

const rootDir = process.cwd();

function loadJson(filePath: string) {
  return JSON.parse(safeReadFile(path.join(rootDir, filePath), { encoding: 'utf8' }) as string);
}

describe('Secret mutation approval schema', () => {
  it('accepts the initial sovereign-only approval workflow', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const schema = loadJson('schemas/secret-mutation-approval.schema.json');
    const validate = ajv.compile(schema);

    const payload = {
      request_id: 'secreq_slack_rotate_001',
      kind: 'secret_mutation',
      status: 'pending',
      created_at: '2026-03-25T00:00:00.000Z',
      requested_by: {
        surface: 'slack',
        actor_id: 'slack-bridge',
        actor_role: 'slack_bridge',
        mission_id: 'MSN-SLACK-001'
      },
      target: {
        service_id: 'slack',
        secret_key: 'SLACK_BOT_TOKEN',
        mutation: 'rotate',
        store: 'os_keychain',
        existing_value_present: true
      },
      justification: {
        reason: 'Socket Mode auth failed during reconcile',
        impact_summary: 'slack-bridge cannot reconnect until the token is updated',
        evidence: ['active/shared/logs/surfaces/slack-bridge.log']
      },
      risk: {
        level: 'high',
        restart_scope: 'service',
        requires_strong_auth: true,
        policy_id: 'secret-slack-rotation'
      },
      workflow: {
        workflow_id: 'wf_secret_single_sovereign_v1',
        mode: 'all_required',
        required_roles: ['sovereign'],
        current_stage: 'primary_approval',
        stages: [
          {
            stage_id: 'primary_approval',
            required_roles: ['sovereign'],
            description: 'Initial sovereign-only operating mode'
          }
        ],
        approvals: [
          {
            role: 'sovereign',
            status: 'pending'
          }
        ]
      }
    };

    const valid = validate(payload);
    expect(valid, ajv.errorsText(validate.errors)).toBe(true);
  });

  it('rejects requests that omit approval roles', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const schema = loadJson('schemas/secret-mutation-approval.schema.json');
    const validate = ajv.compile(schema);

    const payload = {
      request_id: 'secreq_invalid_001',
      kind: 'secret_mutation',
      status: 'pending',
      created_at: '2026-03-25T00:00:00.000Z',
      requested_by: {
        surface: 'terminal',
        actor_id: 'operator-1',
        actor_role: 'chronos_localadmin'
      },
      target: {
        service_id: 'github',
        secret_key: 'GITHUB_TOKEN',
        mutation: 'set'
      },
      justification: {
        reason: 'manual repair'
      },
      risk: {
        level: 'medium',
        restart_scope: 'none',
        requires_strong_auth: false
      },
      workflow: {
        workflow_id: 'wf_invalid',
        mode: 'all_required',
        required_roles: [],
        stages: [],
        approvals: []
      }
    };

    const valid = validate(payload);
    expect(valid).toBe(false);
  });
});
