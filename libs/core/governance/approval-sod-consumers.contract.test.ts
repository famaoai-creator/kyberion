import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile } from '../secure-io.js';
import { evaluateApprovalUsability, type ApprovalRequestRecord } from './approval-store.js';

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
  { file: 'scripts/service_recording.ts', consumer: 'service_recording_review' },
  {
    file: 'libs/core/service/service-recording-review-approval.ts',
    consumer: 'service_recording_promotion',
  },
];

/**
 * A consumer that skips its usability check while separation of duties is off
 * would let a revoked approval through (revocation is refused whatever the
 * setting). Only these files may branch on the setting being off, each for the
 * stated reason; any other consumer file doing so fails the contract.
 */
const SOD_OFF_GUARD_EXCEPTIONS: Readonly<Record<string, string>> = {
  'libs/core/governance/approval-linked-usability.ts':
    'a held action whose linked record is missing is not checked while off (as before); a linked record that exists is always checked',
  'libs/core/governance/approval-gate.ts':
    'a session-cache grant whose seed record is missing is kept while off (as before); a seed that exists is always checked',
  'libs/core/governance/approval-store.ts':
    'decide-time enforcement (enforceSeparationOfDutiesOnDecision) only; apply_claim calls assertApprovalUsable unconditionally',
  'libs/core/service/service-recording-review-approval.ts':
    'a legacy review written before reviews went through the store has no record to check; accepted only while off',
  'scripts/mission-alignment-gate/serve-brief.ts':
    'identity refusals (no owner member, agent session) apply only while on; the decision itself goes through the store',
};

const SOD_OFF_GUARD =
  /!\s*(?:isSeparationOfDutiesEnabled\(\)|resolveSeparationOfDutiesPolicy\(\)\.enabled)/;

/**
 * The mirror image: a usability check that runs only while separation of
 * duties is on (`if (isSeparationOfDutiesEnabled()) assertApprovalUsable(…)`,
 * `enabled && evaluateApprovalUsability(…)`, the else branch of a negated
 * guard) also lets a revoked approval through while off. Only these files may
 * do so, each for the stated reason.
 */
const SOD_ON_GUARD_EXCEPTIONS: Readonly<Record<string, string>> = {};

const USABILITY_CHECKS = new Set([
  'assertApprovalUsable',
  'evaluateApprovalUsability',
  'approvalUsabilityRefusal',
]);

/** True for `isSeparationOfDutiesEnabled()` / `resolveSeparationOfDutiesPolicy().enabled`, or a const bound to one. */
function isSodEnabledExpr(node: ts.Node, aliases: ReadonlySet<string>): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    return node.expression.text === 'isSeparationOfDutiesEnabled';
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'enabled' &&
    ts.isCallExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'resolveSeparationOfDutiesPolicy'
  ) {
    return true;
  }
  return ts.isIdentifier(node) && aliases.has(node.text);
}

/** Polarities (true = enabled, false = negated) of every SoD-enabled test inside `condition`. */
function sodPolarities(condition: ts.Node, aliases: ReadonlySet<string>): boolean[] {
  const found: boolean[] = [];
  const visit = (node: ts.Node, positive: boolean) => {
    if (isSodEnabledExpr(node, aliases)) {
      found.push(positive);
      return;
    }
    const negates =
      ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken;
    ts.forEachChild(node, (child) => visit(child, negates ? !positive : positive));
  };
  visit(condition, true);
  return found;
}

/** Usability checks in `source` that run only while separation of duties is on (line numbers). */
function usabilityChecksUnderSodOn(source: string, fileName = 'probe.ts'): number[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const aliases = new Set<string>();
  const collectAliases = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isSodEnabledExpr(node.initializer, aliases)
    ) {
      aliases.add(node.name.text);
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(file);
  const guardedOn = (node: ts.Node): boolean => {
    for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
      let condition: ts.Node | undefined;
      let wantsPositive = true;
      if (ts.isIfStatement(parent) && child !== parent.expression) {
        condition = parent.expression;
        wantsPositive = child === parent.thenStatement;
      } else if (ts.isConditionalExpression(parent) && child !== parent.condition) {
        condition = parent.condition;
        wantsPositive = child === parent.whenTrue;
      } else if (ts.isBinaryExpression(parent) && child === parent.right) {
        const op = parent.operatorToken.kind;
        if (op === ts.SyntaxKind.AmpersandAmpersandToken) condition = parent.left;
        if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
          condition = parent.left;
          wantsPositive = false;
        }
      }
      if (condition && sodPolarities(condition, aliases).includes(wantsPositive)) return true;
    }
    return false;
  };
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      USABILITY_CHECKS.has(node.expression.text) &&
      guardedOn(node)
    ) {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

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

  it('the decider of the mission brief surface is the server-resolved operator principal', () => {
    expect(read('scripts/mission-alignment-gate/serve-brief.ts')).toContain(
      'resolveCliOperatorIdentity()'
    );
  });

  it('terminal decisions record the operator principal, never the display name', () => {
    expect(read('scripts/lib/approval-cli-decision.ts')).toContain('resolveCliApprovalDecider(');
    for (const file of ['scripts/kyberion_home.ts', 'scripts/cli.ts']) {
      const source = read(file);
      expect(source).toContain('decideApprovalFromCli(');
      expect(source).not.toMatch(/decidedBy:\s*resolveOperatorDisplayName\(\)/);
    }
  });

  it('no consumer skips its usability check while separation of duties is off, except the listed ones', () => {
    expect('if (!isSeparationOfDutiesEnabled()) return;').toMatch(SOD_OFF_GUARD);
    expect('if (!resolveSeparationOfDutiesPolicy().enabled) return null;').toMatch(SOD_OFF_GUARD);
    const files = new Set([
      ...SOD_CONSUMERS.map((entry) => entry.file),
      'scripts/mission-alignment-gate/serve-brief.ts',
    ]);
    const offenders = [...files].filter(
      (file) => SOD_OFF_GUARD.test(read(file)) && !(file in SOD_OFF_GUARD_EXCEPTIONS)
    );
    expect(offenders).toEqual([]);
    for (const [file, reason] of Object.entries(SOD_OFF_GUARD_EXCEPTIONS)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(read(file)).toMatch(
        /isSeparationOfDutiesEnabled\(\)|resolveSeparationOfDutiesPolicy\(\)/
      );
    }
  });

  it('flags a usability check nested under a positive separation-of-duties conditional', () => {
    const flagged = (code: string) => usabilityChecksUnderSodOn(code).length > 0;
    expect(flagged('if (isSeparationOfDutiesEnabled()) assertApprovalUsable(r, o);')).toBe(true);
    expect(
      flagged(
        'if (resolveSeparationOfDutiesPolicy().enabled) { const x = 1; evaluateApprovalUsability(r, o); }'
      )
    ).toBe(true);
    expect(
      flagged('const sod = isSeparationOfDutiesEnabled(); sod && assertApprovalUsable(r, o);')
    ).toBe(true);
    expect(
      flagged('const v = isSeparationOfDutiesEnabled() ? evaluateApprovalUsability(r, o) : null;')
    ).toBe(true);
    expect(
      flagged('if (!isSeparationOfDutiesEnabled()) { log(); } else { assertApprovalUsable(r, o); }')
    ).toBe(true);
    expect(flagged('!isSeparationOfDutiesEnabled() || approvalUsabilityRefusal(r, "x");')).toBe(
      true
    );
    // Unconditional checks, or ones under the opposite polarity, are not this shape.
    expect(flagged('assertApprovalUsable(r, o);')).toBe(false);
    expect(flagged('if (record) assertApprovalUsable(r, o);')).toBe(false);
    expect(
      flagged('if (!isSeparationOfDutiesEnabled()) { log(); } assertApprovalUsable(r, o);')
    ).toBe(false);
    expect(
      flagged('if (isSeparationOfDutiesEnabled()) refuse(); else assertApprovalUsable(r, o);')
    ).toBe(false);
  });

  it('no consumer checks usability only while separation of duties is on, except the listed ones', () => {
    const files = new Set([
      ...SOD_CONSUMERS.map((entry) => entry.file),
      ...Object.keys(SOD_OFF_GUARD_EXCEPTIONS),
      'scripts/mission-alignment-gate/serve-brief.ts',
      'scripts/lib/approval-cli-decision.ts',
    ]);
    const offenders = [...files]
      .filter((file) => !(file in SOD_ON_GUARD_EXCEPTIONS))
      .flatMap((file) =>
        usabilityChecksUnderSodOn(read(file), file).map((line) => `${file}:${line}`)
      );
    expect(offenders).toEqual([]);
    for (const [file, reason] of Object.entries(SOD_ON_GUARD_EXCEPTIONS)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(usabilityChecksUnderSodOn(read(file), file).length).toBeGreaterThan(0);
    }
  });

  it('a revoked record is unusable for every consumer, whatever the separation setting', () => {
    const revoked = {
      id: 'revoked-probe',
      status: 'approved',
      requestedBy: 'agent:planner',
      decidedBy: 'user:alice',
      revocation: { revokedBy: 'user:alice', revokedAt: '2026-10-09T00:00:00.000Z' },
    } as unknown as ApprovalRequestRecord;
    for (const { consumer } of SOD_CONSUMERS) {
      expect(evaluateApprovalUsability(revoked, { consumer })?.violation).toBe('revoked');
    }
  });
});
