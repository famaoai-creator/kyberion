import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { validateWritePermission } from '../tier-guard.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeReaddir } from '../secure-io.js';
import { loadAuthorityRoleIndex } from '../organization/authority-role-registry.js';
import { listDotCharterPaths, loadDotCharter } from './dot-charter.js';

const TEMPLATE_DIR = 'knowledge/product/orchestration/dot-team-templates';
const GUIDE = 'knowledge/product/orchestration/dot-team-starter-playbook.ja.md';
const root = pathResolver.rootDir();
const ids = ['starter-concierge', 'starter-ops-librarian', 'starter-result-verifier'];
const templates = () =>
  ids.map((id) => loadDotCharter(path.join(root, TEMPLATE_DIR, id + '.json')));

afterEach(() => vi.unstubAllEnvs());

describe('inactive three-role dot team starter', () => {
  it.each(['ecosystem_architect', 'software_developer'])(
    'retains no changelog authoring grant for %s',
    (role) => {
      for (const key of ['KYBERION_SUDO', 'KYBERION_TENANT', 'KYBERION_PROJECT_ID', 'MISSION_ID'])
        vi.stubEnv(key, undefined);
      const fragment = 'changelog.d/dot-team-starter-templates.md';
      withExecutionContext(role, () => {
        for (const target of [
          fragment,
          fragment + '/child.md',
          fragment + '.extra',
          'changelog.d/another-fragment.md',
          'CHANGELOG.md',
        ]) {
          expect(validateWritePermission(pathResolver.rootResolve(target)).allowed, target).toBe(
            false
          );
        }
      });
    }
  );

  it('ships exactly three schema-valid drafts outside resident discovery', () => {
    expect(safeReaddir(path.join(root, TEMPLATE_DIR)).sort()).toEqual(
      ids.map((id) => id + '.json')
    );
    const discovered = new Set(listDotCharterPaths(root));
    for (const charter of templates()) {
      expect(charter.status).toBe('draft');
      expect(charter.scope).toEqual({ tier: 'public' });
      expect(discovered.has(path.join(root, TEMPLATE_DIR, charter.dot_id + '.json'))).toBe(false);
      expect(listDotCharterPaths(root).map((file) => loadDotCharter(file).dot_id)).not.toContain(
        charter.dot_id
      );
    }
  });

  it('references existing roles and real schema files without introducing authority', () => {
    const roles = loadAuthorityRoleIndex(root);
    expect(templates().map((c) => c.authority.authority_role)).toEqual([
      'infrastructure_sentinel',
      'knowledge_steward',
      'qa_lead',
    ]);
    for (const charter of templates()) {
      expect(roles[charter.authority.authority_role]).toBeDefined();
      const raw = safeReadFile(path.join(root, TEMPLATE_DIR, charter.dot_id + '.json'), {
        encoding: 'utf8',
      }) as string;
      const schemaRef = /"\$schema":\s*"([^"]+)"/.exec(raw)?.[1];
      expect(schemaRef).toBeDefined();
      expect(path.resolve(root, TEMPLATE_DIR, schemaRef!)).toBe(
        path.join(root, 'knowledge/product/schemas/dot-charter.schema.json')
      );
      expect(safeExistsSync(path.resolve(root, TEMPLATE_DIR, schemaRef!))).toBe(true);
    }
  });

  it('has only inbox wakes and local review delivery, with no cadence or self-scheduling', () => {
    for (const charter of templates()) {
      expect(charter.attention.triggers).toEqual([{ kind: 'wake', channels: ['inbox'] }]);
      expect(charter.notification).toEqual({
        delivery_mode: 'inbox',
        deliver_to: { surface: 'surface', channel: 'dot-team-starter-review' },
      });
      expect(charter.operations_cadence).toBeUndefined();
      expect(charter.followups).toEqual({ max_pending: 0 });
      expect(charter.runtime.reasoning_backend).toBeUndefined();
    }
  });

  it('allows only bounded advisory proposals and never silently raises autonomy', () => {
    for (const charter of templates()) {
      expect(charter.authority.allowed_work_shapes).toEqual(['direct_reply']);
      expect(charter.authority.allowed_pipelines).toEqual([]);
      expect(charter.authority.max_concurrent_delegations).toBe(1);
      expect(charter.decisions).toEqual({
        default_decision: 'approve',
        decision_expiry_minutes: 60,
        escalate_channel: 'surface',
      });
      expect(charter.autonomy).toEqual({ initial_level: 'L1', min_level: 'L1', max_level: 'L1' });
      expect(charter.goal.budget).toEqual({
        max_turns_per_wake: 3,
        wall_clock_ms_per_wake: 120000,
        token_cap_per_day: 20000,
      });
      expect(charter.memory).toEqual({ enabled: true, max_bytes: 4096 });
    }
  });

  it('assigns five exclusive responsibilities without taking the existing owners keys', () => {
    const candidates = templates();
    const responsibilities = candidates.flatMap((c) => c.team?.responsibilities ?? []);
    expect(responsibilities.sort()).toEqual([
      'team.completion-coordination',
      'team.intake',
      'team.knowledge-curation',
      'team.operations-triage',
      'team.result-verification',
    ]);
    expect(new Set(responsibilities).size).toBe(5);
    const heartbeats = candidates.map((c) => c.runtime.heartbeat_id);
    expect(new Set(heartbeats).size).toBe(3);
    for (const id of ['repo-guardian', 'org-operations']) {
      const existing = loadDotCharter(path.join(root, 'dots', id + '.json'));
      expect(existing.team?.responsibilities?.some((key) => responsibilities.includes(key))).toBe(
        false
      );
      expect(heartbeats).not.toContain(existing.runtime.heartbeat_id);
      for (const candidate of candidates) {
        expect(existing.team?.accepts_handoffs_from ?? []).not.toContain(candidate.dot_id);
      }
    }
  });

  it('uses a closed concierge-centered candidate handoff graph, never a self-handoff', () => {
    const candidates = templates();
    expect(
      Object.fromEntries(candidates.map((c) => [c.dot_id, c.team?.accepts_handoffs_from]))
    ).toEqual({
      'starter-concierge': ['starter-result-verifier', 'starter-ops-librarian'],
      'starter-ops-librarian': ['starter-concierge'],
      'starter-result-verifier': ['starter-concierge'],
    });
    for (const candidate of candidates) {
      expect(candidate.team?.accepts_handoffs_from).not.toContain(candidate.dot_id);
      for (const source of candidate.team?.accepts_handoffs_from ?? []) {
        expect(ids).toContain(source);
        expect(candidates.find((c) => c.dot_id === source)?.scope).toEqual(candidate.scope);
      }
    }
  });

  it('keeps independent quality review and current ownership explicit in the loaded goal', () => {
    const candidates = templates();
    const verifier = candidates.find((c) => c.dot_id === 'starter-result-verifier')!;
    expect(verifier.goal.statement).toContain('Refuse self-review');
    expect(verifier.goal.statement).toContain('exact artifact revision or hash');
    expect(verifier.goal.statement).toContain('Never approve a proposal, publish, merge');
    const librarian = candidates.find((c) => c.dot_id === 'starter-ops-librarian')!;
    expect(librarian.goal.statement).toContain('repository.health with repo-guardian');
    expect(librarian.goal.statement).toContain('organization.operations-loop with org-operations');
    expect(librarian.goal.statement).toContain('operator-mediated routing recommendation');
  });

  it('links the activation and handoff playbook to existing local sources', () => {
    const guide = safeReadFile(path.join(root, GUIDE), { encoding: 'utf8' }) as string;
    const links = [...guide.matchAll(/\]\((\.[^#)]+)(?:#[^)]*)?\)/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThanOrEqual(8);
    for (const link of links) {
      expect(safeExistsSync(path.resolve(root, path.dirname(GUIDE), link)), link).toBe(true);
    }
  });
});
