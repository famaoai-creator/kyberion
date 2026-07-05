import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

export interface FinancialPeriod {
  period_id: string;
  label: string;
  revenue_jpy?: number | null;
  operating_cost_jpy?: number | null;
  gross_profit_jpy?: number | null;
  cash_balance_jpy?: number | null;
  budget_jpy?: number | null;
  forecast_jpy?: number | null;
  note?: string | null;
}

export interface FinancialModel {
  company_id: string;
  tenant_slug: string | null;
  source_kind: 'customer' | 'confidential' | 'public' | 'derived';
  source_path: string;
  periods: FinancialPeriod[];
}

export interface FinancialModelSummary {
  company_id: string;
  tenant_slug: string | null;
  source_kind: FinancialModel['source_kind'];
  period_count: number;
  latest_period_id: string | null;
  latest_revenue_jpy: number | null;
  latest_operating_cost_jpy: number | null;
  latest_gross_profit_jpy: number | null;
}

function resolveBaseDir(rootDir?: string): string {
  return rootDir ? path.resolve(rootDir) : pathResolver.rootDir();
}

function loadJsonIfPresent<T>(filePath: string): T | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
  } catch {
    return null;
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function toFinancialPeriod(
  input: Record<string, unknown>,
  periodId: string,
  label: string
): FinancialPeriod {
  return {
    period_id: periodId,
    label,
    revenue_jpy: toNumber(input.revenue_jpy ?? input.revenue),
    operating_cost_jpy: toNumber(
      input.operating_cost_jpy ?? input.operating_cost ?? input.cost_jpy
    ),
    gross_profit_jpy: toNumber(input.gross_profit_jpy ?? input.profit_jpy ?? input.profit),
    cash_balance_jpy: toNumber(input.cash_balance_jpy ?? input.cash_jpy ?? input.cash),
    budget_jpy: toNumber(input.budget_jpy ?? input.budget),
    forecast_jpy: toNumber(input.forecast_jpy ?? input.forecast),
    note: typeof input.note === 'string' ? input.note : null,
  };
}

function loadLegacyCustomerFinancials(
  customerPath: string,
  tenantSlug: string
): FinancialModel | null {
  const customer = loadJsonIfPresent<Record<string, unknown>>(customerPath);
  if (!customer) return null;
  const legacy = customer.financials_prev_fy;
  if (!legacy || typeof legacy !== 'object') return null;
  return {
    company_id: tenantSlug,
    tenant_slug: tenantSlug,
    source_kind: 'customer',
    source_path: customerPath,
    periods: [toFinancialPeriod(legacy as Record<string, unknown>, 'prev_fy', 'Previous FY')],
  };
}

export function resolveFinancialModel(
  tenantSlug?: string | null,
  rootDir?: string
): FinancialModel {
  const baseDir = resolveBaseDir(rootDir);
  const resolvedTenantSlug = tenantSlug?.trim() || null;
  const companyId = resolvedTenantSlug || 'default';
  const candidates = resolvedTenantSlug
    ? [
        path.join(baseDir, 'customer', resolvedTenantSlug, 'finance', 'financial-model.json'),
        path.join(
          baseDir,
          'knowledge',
          'confidential',
          resolvedTenantSlug,
          'finance',
          'financial-model.json'
        ),
        path.join(baseDir, 'knowledge', 'confidential', resolvedTenantSlug, 'financial-model.json'),
      ]
    : [];

  for (const candidate of candidates) {
    const parsed = loadJsonIfPresent<FinancialModel>(candidate);
    if (!parsed || !Array.isArray(parsed.periods)) continue;
    return {
      ...parsed,
      company_id: companyId,
      tenant_slug: resolvedTenantSlug,
      source_path: candidate,
      source_kind: candidate.includes('/customer/')
        ? 'customer'
        : candidate.includes('/confidential/')
          ? 'confidential'
          : 'public',
      periods: parsed.periods.map((period, index) =>
        toFinancialPeriod(
          period as unknown as Record<string, unknown>,
          period.period_id || `period-${index + 1}`,
          period.label || `Period ${index + 1}`
        )
      ),
    };
  }

  const legacy = resolvedTenantSlug
    ? loadLegacyCustomerFinancials(
        path.join(baseDir, 'customer', resolvedTenantSlug, 'customer.json'),
        resolvedTenantSlug
      )
    : null;
  if (legacy) return legacy;

  return {
    company_id: companyId,
    tenant_slug: resolvedTenantSlug,
    source_kind: 'derived',
    source_path:
      candidates[0] ||
      path.join(baseDir, 'knowledge', 'confidential', companyId, 'finance', 'financial-model.json'),
    periods: [],
  };
}

export function summarizeFinancialModel(
  model?: FinancialModel | null
): FinancialModelSummary | undefined {
  if (!model) return undefined;
  const latest = model.periods[model.periods.length - 1] || null;
  return {
    company_id: model.company_id,
    tenant_slug: model.tenant_slug,
    source_kind: model.source_kind,
    period_count: model.periods.length,
    latest_period_id: latest?.period_id || null,
    latest_revenue_jpy: latest?.revenue_jpy ?? null,
    latest_operating_cost_jpy: latest?.operating_cost_jpy ?? null,
    latest_gross_profit_jpy: latest?.gross_profit_jpy ?? null,
  };
}
