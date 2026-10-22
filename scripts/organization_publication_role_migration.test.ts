import { beforeEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ preview: vi.fn(), apply: vi.fn(), request: vi.fn() }));
vi.mock('@agent/core/governance', () => ({
  withExecutionContext: (_role: string, callback: () => unknown) => callback(),
}));
vi.mock('@agent/core/organization/publication-role-migration', () => ({
  previewPublicationRoleMigration: calls.preview,
  applyPublicationRoleMigration: calls.apply,
  requestPublicationRoleMigrationApproval: calls.request,
}));
vi.mock('@agent/core/governance/cli-operator-principal', () => ({
  resolveCliApprovalRequester: () => ({ requestedBy: 'agent:codex' }),
}));
import { runPublicationRoleMigration } from './organization_publication_role_migration.js';
beforeEach(() => {
  calls.preview.mockReset().mockReturnValue({ digest: 'd' });
  calls.apply.mockReset().mockReturnValue({ digest: 'd' });
  calls.request.mockReset().mockReturnValue({ approvalId: 'a', plan: { digest: 'd' } });
});
describe('organization role migration facade', () => {
  it('defaults to preview', () => {
    const print = vi.fn();
    runPublicationRoleMigration(['--source-root', '/source'], print);
    expect(calls.preview).toHaveBeenCalledWith('/source');
    expect(calls.apply).not.toHaveBeenCalled();
  });
  it('requires exact preview and human approval before applying', () => {
    expect(() =>
      runPublicationRoleMigration(['--source-root', '/source', '--apply'], vi.fn())
    ).toThrow('Apply requires');
    runPublicationRoleMigration(
      ['--source-root', '/source', '--apply', '--expected-digest', 'd', '--approval-id', 'a'],
      vi.fn()
    );
    expect(calls.apply).toHaveBeenCalledWith('/source', { expectedDigest: 'd', approvalId: 'a' });
  });
  it('creates the request as the detected agent principal', () => {
    runPublicationRoleMigration(
      ['--source-root', '/source', '--request-approval', '--expected-digest', 'd'],
      vi.fn()
    );
    expect(calls.request).toHaveBeenCalledWith('/source', {
      expectedDigest: 'd',
      requestedBy: 'agent:codex',
    });
    expect(calls.apply).not.toHaveBeenCalled();
  });
  it('reports a reused valid human decision ready to apply', () => {
    calls.request.mockReturnValue({
      approvalId: 'a',
      plan: { digest: 'd' },
      status: 'ready_to_apply',
      reused: true,
    });
    const print = vi.fn();
    runPublicationRoleMigration(
      ['--source-root', '/source', '--request-approval', '--expected-digest', 'd'],
      print
    );
    expect(JSON.parse(print.mock.calls[0][0])).toMatchObject({
      status: 'ready_to_apply',
      reused: true,
    });
    expect(JSON.parse(print.mock.calls[0][0]).next).not.toContain('must approve');
  });
  it('rejects ambiguous apply and dry-run in either order', () => {
    for (const flags of [
      ['--apply', '--dry-run'],
      ['--dry-run', '--apply'],
      ['--request-approval', '--apply'],
    ])
      expect(() =>
        runPublicationRoleMigration(['--source-root', '/source', ...flags], vi.fn())
      ).toThrow('Choose only one');
    expect(calls.preview).not.toHaveBeenCalled();
    expect(calls.apply).not.toHaveBeenCalled();
  });
});
