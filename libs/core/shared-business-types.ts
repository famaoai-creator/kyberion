/**
 * Shared Business & Project Objects for Skill Synergy (v2.0)
 * These interfaces provide a common language for skills to exchange data.
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type Status = 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';

/**
 * Basic identity and strategic intent of a project/company.
 */
export interface ProjectIdentity {
  name: string;
  vision?: string;
  domain?: string;
  stage?: 'idea' | 'seed' | 'series-a' | 'series-b' | 'growth' | 'ipo';
}

/**
 * Technical foundation info detected or used by engineering/talent skills.
 */
export interface TechStackInfo {
  languages: string[];
  frameworks: string[];
  tools: string[];
  infrastructure?: string[];
  database?: string[];
}

/**
 * Represents a physical or logical asset within the ecosystem.
 */
export interface Asset {
  id: string;
  name: string;
  type: 'code' | 'doc' | 'credential' | 'other';
  tenant: string; // One of the 8 companies
  confidentiality: 'public' | 'internal' | 'confidential' | 'restricted';
  hash: string;
  path: string;
  metadata?: Record<string, any>;
  created_at: string;
}

/**
 * Audit trail entry for the Sovereign Asset Ledger.
 */
export interface LedgerEntry {
  action: 'ingest' | 'update' | 'archive' | 'purge';
  asset_id: string;
  timestamp: string;
  actor: string; // e.g., "Ecosystem Architect"
  details: string;
}

/**
 * Unified risk/issue entry for reporting and audit skills.
 */
export interface Issue {
  id: string;
  category?: string;
  severity?: Severity;
  title?: string;
  description?: string;
  risk?: string; 
  impact?: string;
  mitigation?: string;
  location?: string; 
  phase?: string; // Used by PMO
  missing?: string[]; // Used by Audit
}

/**
 * Represents a logical unit of work (Mission).
 */
export interface Mission {
  id: string;
  owner: string;
  objective: string;
  status: Status;
  victory_conditions: string[];
  tasks: Task[];
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  description: string;
  status: Status;
  skill?: string;
  args?: string;
  result?: any;
}

/**
 * Strategic recommendation/action item.
 */
export interface StrategicAction {
  action: string;
  priority: Priority;
  area?: string;
  expectedImpact?: string;
}

/**
 * Represents a pointer to a large data artifact stored on disk.
 */
export interface ArtifactPointer {
  path: string; 
  hash: string;
  format: string;
  size_bytes: number;
  timestamp: string;
  metadata?: Record<string, any>;
}

/**
 * Common financial indicators used by modeling and optimization skills.
 */
export interface FinancialMetrics {
  mrr?: number;
  annualRevenue?: number;
  monthlyBurn?: number;
  cashOnHand?: number;
  growthRate?: number; 
  churnRate?: number;
  grossMargin?: number;
  cac?: number;
  ltv?: number;
}

/**
 * Content container for reporting and document generation.
 */
export interface DocumentArtifact {
  title: string;
  body: string; 
  pointer?: ArtifactPointer;
  metadata?: Record<string, any>;
  format: 'markdown' | 'html' | 'text';
}

/**
 * Standard Report object.
 */
export interface Report {
  missionId: string;
  title: string;
  summary: string;
  findings: Issue[];
  recommendations: StrategicAction[];
  artifacts: ArtifactPointer[];
  metadata?: Record<string, any>;
}

/**
 * Legacy support aliases to prevent broken builds during migration.
 */
export type RiskEntry = Issue;
export type FinancialMetricsV1 = FinancialMetrics;
export type DocumentArtifactV1 = DocumentArtifact;

/**
 * Base Input for many skills.
 */
export interface BusinessInput {
  name: string;
  target?: string;
  options?: Record<string, any>;
  context_files?: string[];
}
