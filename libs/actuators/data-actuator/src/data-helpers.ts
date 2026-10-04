import { createLogger } from '@agent/core/logger';
import { safeReadFile } from '@agent/core/secure-io';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import * as pathResolver from '@agent/core/path-resolver';
import { createAjv } from '@agent/core/foundation';
import type { ValidateFunction } from 'ajv';

const logger = createLogger('data-actuator');

export type DataRow = Record<string, unknown>;

export type DataAction = {
  op: 'query' | 'filter' | 'join' | 'aggregate';
  params?: {
    file?: string;
    file_a?: string;
    file_b?: string;
    key?: string;
    left_key?: string;
    right_key?: string;
    how?: 'inner' | 'left';
    where?: Record<string, unknown>;
    select?: string[];
    sort_by?: string;
    limit?: number;
    group_by?: string;
    aggregations?: Array<{
      func: 'count' | 'sum' | 'avg' | 'min' | 'max';
      field?: string;
      as?: string;
    }>;
  };
};

const DATA_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/data-action.schema.json'
);

let cachedValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = createAjv();
  cachedValidator = compileSchemaFromPath(ajv, DATA_SCHEMA_PATH);
  return cachedValidator;
}

function validateAction(input: unknown): DataAction {
  const validate = getValidator();
  if (!validate(input)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
      .join('; ');
    throw new Error(`data-actuator: invalid input: ${errors}`);
  }
  const action = input as DataAction;
  const missing = missingRequiredFields(action);
  if (missing.length) {
    throw new Error(`data-actuator: missing required fields: ${missing.join(', ')}`);
  }
  return action;
}

function missingRequiredFields(action: DataAction): string[] {
  const params = action.params || {};
  switch (action.op) {
    case 'query':
    case 'filter':
      return params.file ? [] : ['params.file (e.g. "active/shared/staging/rows.json")'];
    case 'join': {
      const missing: string[] = [];
      if (!params.file_a) missing.push('params.file_a');
      if (!params.file_b) missing.push('params.file_b');
      if (!params.key && !(params.left_key && params.right_key)) {
        missing.push('params.key or params.left_key + params.right_key (join key column)');
      }
      return missing;
    }
    case 'aggregate': {
      const missing: string[] = [];
      if (!params.file) missing.push('params.file');
      if (!params.group_by) missing.push('params.group_by (column to group by)');
      if (!params.aggregations?.length)
        missing.push('params.aggregations[0] (e.g. {"func":"count"})');
      return missing;
    }
    default:
      return [];
  }
}

function readRows(file: string): DataRow[] {
  let raw: string;
  try {
    raw = safeReadFile(file, { encoding: 'utf8' }) as string;
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (/not found|ENOENT/i.test(msg)) {
      throw new Error(
        `data-actuator: file not found: ${file} — check the path under active/shared/staging/`
      );
    }
    throw new Error(`data-actuator: cannot read file ${file}: ${msg}`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (file.endsWith('.json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `data-actuator: invalid JSON in ${file} — expected an array of objects or {"rows": [...]}`
      );
    }
    if (Array.isArray(parsed)) return parsed as DataRow[];
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).rows)) {
      return (parsed as any).rows as DataRow[];
    }
    throw new Error(
      `data-actuator: invalid JSON in ${file} — expected an array of objects or {"rows": [...]}`
    );
  }
  if (file.endsWith('.csv')) {
    return parseCsv(raw, file);
  }
  throw new Error(`data-actuator: unsupported file type for ${file} — use .json or .csv`);
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

function parseCsv(raw: string, file: string): DataRow[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]);
  if (!headers.length || headers.some((h) => !h)) {
    throw new Error(
      `data-actuator: invalid CSV header in ${file} — first row must list column names`
    );
  }
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: DataRow = {};
    headers.forEach((h, idx) => {
      row[h] = cells[idx] ?? '';
    });
    return row;
  });
}

function matchesWhere(row: DataRow, where?: Record<string, unknown>): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

function project(row: DataRow, select?: string[]): DataRow {
  if (!select?.length) return row;
  const out: DataRow = {};
  for (const col of select) out[col] = row[col];
  return out;
}

function doQuery(params: NonNullable<DataAction['params']>): DataRow[] {
  let rows = readRows(params.file as string).filter((r) => matchesWhere(r, params.where));
  rows = rows.map((r) => project(r, params.select));
  if (params.sort_by) {
    const key = params.sort_by;
    rows = [...rows].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av === bv) return 0;
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av) < String(bv) ? -1 : 1;
    });
  }
  if (params.limit !== undefined) rows = rows.slice(0, params.limit);
  return rows;
}

function doJoin(params: NonNullable<DataAction['params']>): DataRow[] {
  const leftKey = params.left_key || params.key;
  const rightKey = params.right_key || params.key;
  if (!leftKey || !rightKey) {
    throw new Error(
      'data-actuator: join requires params.key or params.left_key + params.right_key'
    );
  }
  const how = params.how || 'inner';
  const left = readRows(params.file_a as string);
  const right = readRows(params.file_b as string);
  if (left.length && !(leftKey in left[0])) {
    throw new Error(`data-actuator: bad key — "${leftKey}" not found in ${params.file_a} columns`);
  }
  if (right.length && !(rightKey in right[0])) {
    throw new Error(`data-actuator: bad key — "${rightKey}" not found in ${params.file_b} columns`);
  }
  const index = new Map<string, DataRow[]>();
  for (const r of right) {
    const k = String(r[rightKey]);
    const bucket = index.get(k) || [];
    bucket.push(r);
    index.set(k, bucket);
  }
  const out: DataRow[] = [];
  for (const l of left) {
    const hits = index.get(String(l[leftKey]));
    if (hits?.length) {
      for (const r of hits) out.push({ ...r, ...l });
    } else if (how === 'left') {
      out.push({ ...l });
    }
  }
  return out;
}

function doAggregate(params: NonNullable<DataAction['params']>): DataRow[] {
  const rows = readRows(params.file as string);
  const groupBy = params.group_by as string;
  const aggs = params.aggregations as NonNullable<
    NonNullable<DataAction['params']>['aggregations']
  >;
  const groups = new Map<string, DataRow[]>();
  for (const r of rows) {
    const k = String(r[groupBy]);
    const bucket = groups.get(k) || [];
    bucket.push(r);
    groups.set(k, bucket);
  }
  return [...groups.entries()].map(([group, bucket]) => {
    const out: DataRow = { [groupBy]: group };
    for (const agg of aggs) {
      const name = agg.as || `${agg.func}${agg.field ? `_${agg.field}` : ''}`;
      if (agg.func === 'count') {
        out[name] = bucket.length;
        continue;
      }
      const values = bucket
        .map((r) => Number(r[agg.field as string]))
        .filter((n) => Number.isFinite(n));
      if (!agg.field) {
        throw new Error(
          `data-actuator: aggregation "${agg.func}" requires a field (e.g. {"func":"sum","field":"amount"})`
        );
      }
      if (agg.func === 'sum') out[name] = values.reduce((a, b) => a + b, 0);
      else if (agg.func === 'avg')
        out[name] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      else if (agg.func === 'min') out[name] = values.length ? Math.min(...values) : null;
      else if (agg.func === 'max') out[name] = values.length ? Math.max(...values) : null;
    }
    return out;
  });
}

export async function handleAction(action: DataAction): Promise<unknown> {
  const valid = validateAction(action);
  const params = valid.params || {};
  logger.debug('action.received', { op: valid.op });
  switch (valid.op) {
    case 'query':
      return doQuery(params);
    case 'filter':
      return readRows(params.file as string).filter((r) => matchesWhere(r, params.where));
    case 'join':
      return doJoin(params);
    case 'aggregate':
      return doAggregate(params);
    default:
      throw new Error(`data-actuator: invalid input: unknown op ${(action as any)?.op}`);
  }
}
