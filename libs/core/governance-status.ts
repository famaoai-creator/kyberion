import { loadApprovalPolicy } from './approval-policy.js';
import { listApprovalRequests } from './approval-store.js';
import { loadAllowedEgressDomains, loadEgressPolicy } from './egress-policy.js';
import { killSwitch } from './kill-switch.js';
import { loadShellCommandPolicy } from './shell-command-policy.js';

export interface GovernanceControlSummary {
  kill_switch_monitoring: boolean;
  pending_approvals: number;
  approval_rules: number;
  shell_allow_rules: number;
  shell_deny_rules: number;
  egress_mode: string;
  egress_allowlist_domains: number;
}

export function getGovernanceControlSummary(): GovernanceControlSummary {
  const approvalPolicy = loadApprovalPolicy();
  const shellPolicy = loadShellCommandPolicy();
  const egressPolicy = loadEgressPolicy();
  const pendingApprovals = listApprovalRequests({ status: 'pending' }).length;
  const approvalRules = approvalPolicy.rules?.length ?? 0;
  const shellAllowRules = shellPolicy.allowlist?.length ?? 0;
  const shellDenyRules = shellPolicy.denylist?.length ?? 0;
  const egressDomains = loadAllowedEgressDomains().length;

  return {
    kill_switch_monitoring: killSwitch.isMonitoring(),
    pending_approvals: pendingApprovals,
    approval_rules: approvalRules,
    shell_allow_rules: shellAllowRules,
    shell_deny_rules: shellDenyRules,
    egress_mode: egressPolicy.mode || 'warn',
    egress_allowlist_domains: egressDomains,
  };
}
