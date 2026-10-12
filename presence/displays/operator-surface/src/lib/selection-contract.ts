/** Public, secret-free selection view shared by the browser and server adapters. */
export type SelectionMode = 'auto' | 'preferred' | 'fixed';
export type SelectionKind = 'mission' | 'reasoning';
export interface SelectionRequest {
  mode: SelectionMode;
  agent_id?: string;
  runtime_mode?: string;
  provider?: string;
  model?: string;
  profile?: string;
}
export interface SelectionChoice {
  value: string;
  provider?: string;
  model?: string;
  models?: string[];
  profiles?: string[];
  eligible?: boolean;
  reason?: string;
}
export interface SelectionRow {
  role: string;
  requested: SelectionRequest | null;
  effective: Omit<SelectionRequest, 'mode'> | null;
  source: string;
  reason: string;
  valid: boolean;
  fallback: boolean;
  conflict?: boolean;
  /** Current eligibility is separate from the persisted dispatch target. */
  eligibility?: { eligible: boolean; reason: string };
  details?: Array<{ target: string; reason: string }>;
  choices: SelectionChoice[];
}
export interface SelectionSnapshot {
  revision: string;
  previewToken?: string;
  rows: SelectionRow[];
  canEdit: boolean;
}
export interface SelectionCommand {
  action: 'preview' | 'save';
  role: string;
  selection: SelectionRequest;
  expectedRevision: string;
  expectedPreviewToken?: string;
}
export interface SelectionTarget {
  kind: SelectionKind;
  missionId?: string;
}
export class SelectionResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string
  ) {
    super(code);
    this.name = 'SelectionResponseError';
  }
}
export type SelectionTransport = (
  target: SelectionTarget,
  command: SelectionCommand | null,
  signal: AbortSignal
) => Promise<SelectionSnapshot>;

/** Construct only the two fixed local endpoints; never accept a URL from data. */
export function selectionEndpoint(target: SelectionTarget): string {
  if (target.kind === 'reasoning') return '/api/reasoning/selection';
  if (!target.missionId || !/^MSN-[A-Z0-9][A-Z0-9_-]{0,127}$/.test(target.missionId)) {
    throw new SelectionResponseError(400, 'INVALID_MISSION_ID');
  }
  return '/api/missions/' + encodeURIComponent(target.missionId) + '/selection';
}

/** Independent sequence numbers prevent late preview/save replies replacing a newer view. */
export class SelectionRequestGate {
  private version = 0;
  private pending: AbortController | null = null;
  begin(): { version: number; signal: AbortSignal } | null {
    if (this.pending) return null;
    this.pending = new AbortController();
    return { version: ++this.version, signal: this.pending.signal };
  }
  accepts(version: number): boolean {
    return version === this.version && this.pending !== null;
  }
  complete(version: number): void {
    if (this.accepts(version)) this.pending = null;
  }
  cancel(): void {
    ++this.version;
    this.pending?.abort();
    this.pending = null;
  }
}
