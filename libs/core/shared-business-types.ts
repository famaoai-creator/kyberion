/**
 * Shared Business & Project Objects for Skill Synergy
 * These interfaces provide a common language for skills to exchange data.
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type Priority = 'low' | 'medium' | 'high' | 'critical';

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
 * Common financial indicators used by modeling and optimization skills.
 */
export interface FinancialMetrics {
  mrr?: number;
  annualRevenue?: number;
  monthlyBurn?: number;
  cashOnHand?: number;
  growthRate?: number; // Monthly decimal (e.g., 0.05 for 5%)
  churnRate?: number; // Monthly decimal
  grossMargin?: number; // Decimal (e.g., 0.8 for 80%)
  cac?: number; // Customer Acquisition Cost
  ltv?: number; // Lifetime Value
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
 * Unified risk entry for reporting and audit skills.
 */
export interface RiskEntry {
  category: string;
  severity: Severity;
  risk: string;
  impact?: string;
  mitigation?: string;
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
 * Used in ADF to maintain audit trails without bloating JSON payloads.
 */
export interface ArtifactPointer {
  path: string; // Physical location relative to project root
  hash: string; // SHA-256 integrity hash
  format: string; // e.g., 'markdown', 'json', 'pdf'
  size_bytes: number;
  metadata?: Record<string, any>;
}

/**
 * Content container for reporting and document generation.
 */
export interface DocumentArtifact {
  title: string;
  body: string; // Markdown or HTML (Primary content or summary)
  pointer?: ArtifactPointer; // Optional pointer for large data
  metadata?: Record<string, any>;
  format: 'markdown' | 'html' | 'text';
}
