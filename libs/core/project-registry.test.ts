import { beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReaddir, safeRmSync } from './secure-io.js';
import { buildProjectBootstrapWorkItems, listProjectRecords, loadProjectRecord, resolveProjectRecordForText, saveProjectRecord } from './project-registry.js';
import { listServiceBindingRecords, loadServiceBindingRecord, saveServiceBindingRecord } from './service-binding-registry.js';
import { attachArtifactRecordToTaskSession, createArtifactRecord, loadArtifactRecord, saveArtifactRecord } from './artifact-record.js';
import { createTaskSession, saveTaskSession } from './task-session.js';

function cleanupByPrefix(dir: string, prefix: string) {
  if (!safeExistsSync(dir)) return;
  for (const entry of safeReaddir(dir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
    safeRmSync(`${dir}/${entry}`);
  }
}

describe('project and artifact registries', () => {
  beforeEach(() => {
    cleanupByPrefix(pathResolver.shared('runtime/projects'), 'PRJ-TEST-');
    cleanupByPrefix(pathResolver.shared('runtime/service-bindings'), 'BIND-TEST-');
    cleanupByPrefix(pathResolver.shared('runtime/artifacts'), 'ART-TEST-');
    cleanupByPrefix(pathResolver.shared('runtime/task-sessions'), 'TSK-TEST-');
  });

  it('persists project records', () => {
    saveProjectRecord({
      project_id: 'PRJ-TEST-WEB',
      name: 'Test Web Service',
      summary: 'Test project',
      status: 'active',
      tier: 'confidential',
      primary_locale: 'ja-JP',
      service_bindings: ['BIND-TEST-GITHUB'],
      bootstrap_work_items: buildProjectBootstrapWorkItems({
        projectId: 'PRJ-TEST-WEB',
        projectName: 'Test Web Service',
        utterance: '新しい Webサービスを作って',
      }),
      kickoff_task_session_id: 'TSK-TEST-KICKOFF',
      proposed_mission_ids: ['WRK-TEST-ARCH'],
    });
    expect(loadProjectRecord('PRJ-TEST-WEB')?.name).toBe('Test Web Service');
    expect(loadProjectRecord('PRJ-TEST-WEB')?.primary_locale).toBe('ja-JP');
    expect(loadProjectRecord('PRJ-TEST-WEB')?.kickoff_task_session_id).toBe('TSK-TEST-KICKOFF');
    expect(listProjectRecords().some((item) => item.project_id === 'PRJ-TEST-WEB')).toBe(true);
    expect(resolveProjectRecordForText({ utterance: 'Test Web Service の試験計画を作って' })?.project_id).toBe('PRJ-TEST-WEB');
  });

  it('persists service binding records', () => {
    saveServiceBindingRecord({
      binding_id: 'BIND-TEST-GITHUB',
      service_type: 'github',
      scope: 'repository',
      target: 'org/repo',
      allowed_actions: ['read', 'pull_request'],
      secret_refs: ['vault://bindings/github/test/token'],
      approval_policy: { pull_request: 'allowed', merge: 'approval_required' },
      service_id: 'github',
      auth_mode: 'secret-guard',
    });
    expect(loadServiceBindingRecord('BIND-TEST-GITHUB')?.service_type).toBe('github');
    expect(listServiceBindingRecords().some((item) => item.binding_id === 'BIND-TEST-GITHUB')).toBe(true);
  });

  it('persists artifact ownership and attaches it to a task session', () => {
    const session = createTaskSession({
      sessionId: 'TSK-TEST-ARTIFACT',
      surface: 'presence',
      taskType: 'presentation_deck',
      goal: {
        summary: 'Create a deck',
        success_condition: 'pptx exists',
      },
      payload: {
        deck_purpose: 'proposal',
      },
    });
    saveTaskSession(session);
    const artifact = createArtifactRecord({
      artifact_id: 'ART-TEST-DECK',
      project_id: 'PRJ-TEST-WEB',
      task_session_id: 'TSK-TEST-ARTIFACT',
      kind: 'pptx',
      storage_class: 'artifact_store',
      path: 'active/shared/tmp/example.pptx',
      preview_text: 'Deck generated.',
    });
    saveArtifactRecord(artifact);
    attachArtifactRecordToTaskSession('TSK-TEST-ARTIFACT', artifact);
    expect(loadArtifactRecord('ART-TEST-DECK')?.project_id).toBe('PRJ-TEST-WEB');
  });

  it('builds bootstrap work items for project creation flows', () => {
    const items = buildProjectBootstrapWorkItems({
      projectId: 'PRJ-TEST-WEB',
      projectName: 'Test Web Service',
      utterance: '新しい Webサービスを作って',
    });
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items[0]?.kind).toBe('task_session');
    expect(items[0]?.specialist_id).toBe('project-lead');
    expect(items.some((item) => item.title.toLowerCase().includes('architecture'))).toBe(true);
  });
});
