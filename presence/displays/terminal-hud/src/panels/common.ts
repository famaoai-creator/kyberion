import type { OperatorHomeApprovalItem } from '@agent/core/surface/operator-home-summary';
export interface PanelProps {
  isActive: boolean;
  refreshNonce: number;
  /** Already filtered by the authoritative operator-home scope facade. */
  pendingApprovals?: OperatorHomeApprovalItem[];
}
