import type { WorkspaceSelection } from '@agent/core/surface/workspace-scope';
export const INGEST_UPLOAD_FORMATS = ['docx', 'pdf', 'xlsx', 'html', 'markdown', 'text'] as const;

export type IngestUploadFormat = (typeof INGEST_UPLOAD_FORMATS)[number];

export type IngestFormInput = {
  file: File;
  tenant: string;
  format: IngestUploadFormat | '';
  dryRun: boolean;
  workspace: WorkspaceSelection;
};

export type IngestFormParseResult =
  | { ok: true; value: IngestFormInput }
  | { ok: false; field: 'file' | 'tenant' | 'format' | 'dry_run' | 'scope' | 'unknown' };

const INGEST_FORM_FIELDS = new Set([
  'file',
  'tenant',
  'format',
  'dry_run',
  'organization_id',
  'project_id',
  'operation_id',
  'tier',
]);

function readSingle(form: FormData, field: string): unknown {
  const values = form.getAll(field);
  return values.length === 1 ? values[0] : values.length === 0 ? undefined : null;
}

function readText(
  form: FormData,
  field: 'tenant' | 'format' | 'dry_run'
): { ok: true; value: string | undefined } | { ok: false } {
  const value = readSingle(form, field);
  if (value === undefined) return { ok: true, value: undefined };
  return typeof value === 'string' ? { ok: true, value } : { ok: false };
}

function parseDryRun(value: string | undefined): boolean | null {
  if (value === undefined || value === '') return false;
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'off':
      return false;
    default:
      return null;
  }
}

/** Normalize the multipart boundary before tenant lookup or file staging. */
export function parseIngestForm(form: FormData): IngestFormParseResult {
  for (const key of form.keys()) {
    if (!INGEST_FORM_FIELDS.has(key)) return { ok: false, field: 'unknown' };
  }

  const file = readSingle(form, 'file');
  if (!(file instanceof File)) return { ok: false, field: 'file' };

  const tenant = readText(form, 'tenant');
  if (!tenant.ok) return { ok: false, field: 'tenant' };

  const format = readText(form, 'format');
  if (!format.ok) return { ok: false, field: 'format' };
  const normalizedFormat = format.value?.trim() || '';
  if (
    normalizedFormat &&
    !(INGEST_UPLOAD_FORMATS as readonly string[]).includes(normalizedFormat)
  ) {
    return { ok: false, field: 'format' };
  }

  const dryRun = readText(form, 'dry_run');
  if (!dryRun.ok) return { ok: false, field: 'dry_run' };
  const parsedDryRun = parseDryRun(dryRun.value);
  if (parsedDryRun === null) return { ok: false, field: 'dry_run' };

  const normalizedTenant = tenant.value?.trim() || '';
  const workspace: WorkspaceSelection = normalizedTenant ? { tenant_slug: normalizedTenant } : {};
  for (const field of ['organization_id', 'project_id', 'operation_id', 'tier'] as const) {
    const value = readSingle(form, field);
    if (value === undefined) continue;
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      (field === 'tier'
        ? !['public', 'confidential', 'personal'].includes(value)
        : !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))
    )
      return { ok: false, field: 'scope' };
    Object.assign(workspace, { [field]: value });
  }
  if (workspace.project_id && workspace.operation_id) return { ok: false, field: 'scope' };
  if (
    !normalizedTenant &&
    !workspace.project_id &&
    !(workspace.organization_id && (workspace.tier === 'public' || workspace.tier === 'personal'))
  )
    return { ok: false, field: 'tenant' };

  return {
    ok: true,
    value: {
      file,
      tenant: normalizedTenant,
      format: normalizedFormat as IngestUploadFormat | '',
      dryRun: parsedDryRun,
      workspace,
    },
  };
}
