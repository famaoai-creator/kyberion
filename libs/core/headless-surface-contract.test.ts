import { describe, expect, it } from 'vitest';
import {
  availableHeadlessOperationIds,
  buildComputerSurfaceManifest,
  buildChronosHeadlessManifest,
  createHeadlessEnvelope,
} from './headless-surface-contract.js';

describe('headless surface contract', () => {
  it('publishes discoverable read resources and an explicit localadmin write operation', () => {
    const manifest = buildChronosHeadlessManifest();

    expect(manifest.api_version).toBe('1');
    expect(manifest.surface).toBe('chronos');
    expect(manifest.resources.map((resource) => resource.resource)).toEqual([
      'operator-home',
      'work-items',
      'collaboration',
    ]);

    const update = manifest.operations.find(
      (operation) => operation.operation_id === 'chronos.work_items.update_status'
    );
    expect(update).toMatchObject({
      effect: 'write',
      required_role: 'localadmin',
      required_permissions: ['surface.headless.write'],
      method: 'POST',
    });
    expect(update?.input_schema.required).toEqual(['item_id', 'status']);
    expect(update).not.toHaveProperty('governedCode');
  });

  it('does not advertise write operations to readonly viewers', () => {
    const manifest = buildChronosHeadlessManifest();

    expect(availableHeadlessOperationIds('readonly', manifest)).toEqual([
      'chronos.operator_home.read',
      'chronos.work_items.read',
      'chronos.collaboration.read',
    ]);
    expect(availableHeadlessOperationIds('localadmin', manifest)).toContain(
      'chronos.work_items.update_status'
    );
  });

  it('keeps server-resolved scope and available operations in every envelope', () => {
    const envelope = createHeadlessEnvelope({
      resource: 'operator-home',
      data: { status: 'ready' },
      scope: {
        role: 'readonly',
        principal_id: 'viewer-1',
        tenant_slugs: ['tenant-a'],
        organization_ids: [],
        project_ids: [],
        tier_access: ['public'],
      },
    });

    expect(envelope).toMatchObject({
      ok: true,
      api_version: '1',
      surface: 'chronos',
      resource: 'operator-home',
      scope: {
        role: 'readonly',
        tenant_slugs: ['tenant-a'],
      },
      data: { status: 'ready' },
    });
    expect(envelope.available_operations).not.toContain('chronos.work_items.update_status');
  });

  it('publishes Computer Surface read/write operations with the same RBAC contract', () => {
    const manifest = buildComputerSurfaceManifest();
    expect(manifest.surface).toBe('computer-surface');

    expect(availableHeadlessOperationIds('readonly', manifest)).toEqual([
      'computer_surface.manifest.read',
      'computer_surface.state.read',
      'computer_surface.stream.read',
      'computer_surface.os_control_plane.read',
    ]);
    expect(availableHeadlessOperationIds('localadmin', manifest)).toContain(
      'computer_surface.a2ui.dispatch'
    );

    const dispatch = manifest.operations.find(
      (operation) => operation.operation_id === 'computer_surface.a2ui.dispatch'
    );
    expect(dispatch).toMatchObject({
      effect: 'write',
      required_role: 'localadmin',
      required_permissions: ['surface.headless.write'],
      method: 'POST',
    });
  });
});
