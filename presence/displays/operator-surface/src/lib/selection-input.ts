import type { SelectionCommand, SelectionKind, SelectionRequest } from './selection-contract';

const COMMON = ['mode', 'provider', 'model'];
export function parseSelectionCommand(
  value: Record<string, unknown>,
  kind: SelectionKind
): SelectionCommand | null {
  if (
    Object.keys(value).some(
      (key) =>
        !['action', 'role', 'selection', 'expectedRevision', 'expectedPreviewToken'].includes(key)
    )
  )
    return null;
  if (value.action !== 'preview' && value.action !== 'save') return null;
  if (typeof value.role !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value.role))
    return null;
  if (
    typeof value.expectedRevision !== 'string' ||
    !/^[a-zA-Z0-9:_.-]{1,256}$/.test(value.expectedRevision)
  )
    return null;
  if (
    value.expectedPreviewToken !== undefined &&
    (kind !== 'mission' ||
      typeof value.expectedPreviewToken !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.expectedPreviewToken))
  )
    return null;
  if (
    kind === 'mission' &&
    value.action === 'save' &&
    typeof value.expectedPreviewToken !== 'string'
  )
    return null;
  if (!value.selection || typeof value.selection !== 'object' || Array.isArray(value.selection))
    return null;
  const input = value.selection as Record<string, unknown>;
  const allowed = [...COMMON, ...(kind === 'mission' ? ['agent_id'] : ['runtime_mode', 'profile'])];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return null;
  if (!['auto', 'preferred', 'fixed'].includes(String(input.mode))) return null;
  const selection: SelectionRequest = { mode: input.mode as SelectionRequest['mode'] };
  for (const key of allowed.filter((key) => key !== 'mode')) {
    const item = input[key];
    if (item === undefined) continue;
    if (
      typeof item !== 'string' ||
      !item.trim() ||
      item.length > 160 ||
      /[\x00-\x1f\x7f]/.test(item)
    )
      return null;
    Object.assign(selection, { [key]: item.trim() });
  }
  if (selection.mode === 'auto' && Object.keys(selection).length !== 1) return null;
  if (selection.mode !== 'auto' && kind === 'reasoning' && !selection.runtime_mode) return null;
  if (
    selection.mode !== 'auto' &&
    kind === 'mission' &&
    !selection.agent_id &&
    !selection.provider &&
    !selection.model
  )
    return null;
  return {
    action: value.action,
    role: value.role,
    selection,
    expectedRevision: value.expectedRevision,
    ...(typeof value.expectedPreviewToken === 'string'
      ? { expectedPreviewToken: value.expectedPreviewToken }
      : {}),
  };
}
