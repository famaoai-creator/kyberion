import { describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile } from '../secure-io.js';

/**
 * Registration ceremony for separation of duties: every consumer that turns an
 * approved record into an effect runs `assertApprovalUsable` /
 * `approvalUsabilityRefusal` / `evaluateApprovalUsability` under a consumer id,
 * and approval-gate-design.md lists exactly these ids. Adding a consumer means
 * adding it here and to the doc; removing a check fails this test.
 */
const SOD_CONSUMERS: ReadonlyArray<{ file: string; consumer: string }> = [
  { file: 'libs/core/governance/approval-gate.ts', consumer: 'approval_gate' },
  { file: 'libs/core/governance/approval-gate.ts', consumer: 'approval_gate_session_cache' },
  { file: 'libs/core/governance/approval-store.ts', consumer: 'apply_claim' },
  { file: 'libs/core/project/project-trust.ts', consumer: 'project_trust' },
  { file: 'libs/core/dot/dot-executor-release.ts', consumer: 'dot_release' },
  { file: 'libs/core/dot/dot-dispatch.ts', consumer: 'dot_dispatch' },
  { file: 'libs/core/dot/dot-autonomy.ts', consumer: 'dot_autonomy_promotion' },
  { file: 'libs/core/surface/front-desk-execution.ts', consumer: 'front_desk_execution' },
  { file: 'libs/core/discussion/discussion-mission.ts', consumer: 'discussion_mission' },
  { file: 'libs/core/plugin/plugin-view-actions.ts', consumer: 'plugin_view_action' },
  { file: 'libs/core/plugin/plugin-activation-status.ts', consumer: 'plugin_activation' },
  { file: 'libs/shared-network/src/mcp-server-engine.ts', consumer: 'mcp_governed_tool' },
  { file: 'scripts/pipeline-execution-part-execution.ts', consumer: 'pipeline_await_decision' },
  { file: 'scripts/pipeline-execution-part-control.ts', consumer: 'pipeline_bound_approval' },
  { file: 'libs/core/mission/mission-maintenance.ts', consumer: 'mission_scope_approve' },
  { file: 'libs/core/mission/mission-work-reconciliation.ts', consumer: 'mission_reconcile_work' },
  { file: 'libs/core/secret/secret-introduction.ts', consumer: 'secret_introduction' },
  { file: 'libs/core/workforce/background-review-patch.ts', consumer: 'background_review_patch' },
  { file: 'libs/core/mesh/peer-runtime-recovery.ts', consumer: 'peer_runtime_recovery' },
  { file: 'libs/core/marketing-workload.ts', consumer: 'marketing_publication' },
  { file: 'libs/core/governance/approval-linked-usability.ts', consumer: 'held_action_apply' },
  { file: 'libs/core/agent/agent-prompt-approval.ts', consumer: 'agent_prompt_approval' },
  {
    file: 'libs/actuators/system-actuator/src/system-action-helpers.ts',
    consumer: 'system_actuator_computer',
  },
  {
    file: 'libs/actuators/approval-actuator/src/approval-ops.ts',
    consumer: 'approval_actuator_request_review',
  },
  { file: 'scripts/audit_mirror_reconcile.ts', consumer: 'audit_mirror_reconcile' },
  { file: 'scripts/entity_governance_cleanup.ts', consumer: 'entity_governance_cleanup' },
  { file: 'scripts/mission_alignment_decision.ts', consumer: 'mission_alignment_gate' },
  { file: 'scripts/organization_decision_approval.ts', consumer: 'organization_decision' },
  { file: 'scripts/org.ts', consumer: 'org_security_policy_write' },
  { file: 'scripts/personal-workbench/actions.ts', consumer: 'personal_workbench' },
];

/** Surfaces that record `deciderIdentitySource: 'caller_supplied'`. */
const CALLER_SUPPLIED_SURFACES = [
  'libs/core/governance/approval-cowork-adapter.ts',
  'libs/actuators/approval-actuator/src/approval-actuator-helpers.ts',
];

const read = (file: string) =>
  String(safeReadFile(pathResolver.rootResolve(file), { encoding: 'utf8' }));

/**
 * The id must be passed to a separation-of-duties check, not merely appear:
 * `assertApprovalUsable(x, { consumer: '<id>' })`,
 * `evaluateApprovalUsability(x, { consumer: '<id>' })` or
 * `approvalUsabilityRefusal(x, '<id>')`.
 */
function callShapeFor(consumer: string): RegExp {
  const id = consumer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:assertApprovalUsable|evaluateApprovalUsability)\\([^;]*?\\{[^}]*\\bconsumer: '${id}'` +
      `|approvalUsabilityRefusal\\([^;]*?,\\s*'${id}'\\s*\\)`,
    's'
  );
}

describe('separation-of-duties consumer registry', () => {
  const doc = read('knowledge/product/governance/approval-gate-design.md');

  it('accepts only the call shapes, not a bare mention of the id', () => {
    const shape = callShapeFor('demo_consumer');
    expect("assertApprovalUsable(record, { consumer: 'demo_consumer' });").toMatch(shape);
    expect("evaluateApprovalUsability(record, { consumer: 'demo_consumer' })").toMatch(shape);
    expect("approvalUsabilityRefusal(record, 'demo_consumer');").toMatch(shape);
    expect("// consumer: 'demo_consumer'").not.toMatch(shape);
    expect("const id = 'demo_consumer';").not.toMatch(shape);
    expect(
      "assertApprovalUsable(record, { consumer: 'other' }); log('demo_consumer');"
    ).not.toMatch(shape);
  });

  it.each(SOD_CONSUMERS)('$file checks approvals as `$consumer`', ({ file, consumer }) => {
    expect(read(file)).toMatch(callShapeFor(consumer));
    expect(doc).toContain(`\`${consumer}\``);
  });

  it.each(CALLER_SUPPLIED_SURFACES)('%s marks its decider as caller_supplied', (file) => {
    expect(read(file)).toContain("deciderIdentitySource: 'caller_supplied'");
    expect(doc).toContain(`\`${file}\``);
  });

  it('the decider of the mission brief surface is resolved server-side', () => {
    expect(read('scripts/mission-alignment-gate/serve-brief.ts')).toContain(
      'resolveOperatorDisplayName()'
    );
  });
});
