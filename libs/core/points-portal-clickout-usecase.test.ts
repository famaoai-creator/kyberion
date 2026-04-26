import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath, safeReadFile } from '@agent/core';
import { describe, expect, it } from 'vitest';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('points-portal-clickout-usecase schema', () => {
  it('accepts the canonical example', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/public/schemas/points-portal-clickout-usecase.schema.json'));
    const example = JSON.parse(
      safeReadFile(path.resolve(root, 'knowledge/public/schemas/points-portal-clickout-usecase.moppy-rakuten-travel.example.json'), {
        encoding: 'utf8',
      }) as string,
    );

    expect(validate(example)).toBe(true);
  });

  it('rejects payloads that omit required blocked actions and approvals', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/public/schemas/points-portal-clickout-usecase.schema.json'));

    const invalid = {
      kind: 'points-portal-clickout-usecase',
      usecase_id: 'moppy-rakuten-travel',
      mode: 'simulation',
      points_portal: {
        id: 'moppy',
        display_name: 'Moppy',
      },
      merchant: {
        id: 'rakuten_travel',
        display_name: 'Rakuten Travel',
      },
      auth_strategy: {
        type: 'dedicated_browser_profile',
        approval_required: false,
      },
      portal_detail_url: 'https://pc.moppy.jp/shopping/detail.php?site_id=903&track_ref=sea',
      clickout: {
        selector: 'form#toClient > button:nth-of-type(1)',
        operator_confirmation_required: true,
      },
      landing_match: {
        url_includes: 'travel.rakuten.co.jp',
      },
      blocked_actions: ['reservation_confirmation'],
      evidence_required: ['portal_name'],
      success_criteria: {
        landing_url_includes: 'travel.rakuten.co.jp',
        handoff_export_absent: true,
        blocked_actions_not_executed: true,
        merchant_landing_captured: true,
      },
      artifact_policy: {
        forbid_session_handoff_export: true,
        allowed_artifact_roots: ['active/shared/tmp/browser'],
        retain_browser_profile: true,
        delete_continue_files: true,
      },
      preflight: {
        require_clickout_selector: true,
        require_landing_match: true,
        require_blocked_actions: true,
        deny_ops: ['payment_execution'],
      },
    };

    expect(validate(invalid)).toBe(false);
  });
});
