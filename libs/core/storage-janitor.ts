export interface ScanTmpResult {
  path: string;
  entries: number;
  bytes: number;
}

export interface RotateLogsResult {
  path: string;
  rotated: number;
  archived: number;
}

export interface ScanDataVaultResult {
  path: string;
  entries: number;
  bytes: number;
}

export interface JanitorReport {
  scanned_tmp: ScanTmpResult[];
  rotated_logs: RotateLogsResult[];
  scanned_data_vault: ScanDataVaultResult[];
  removed: number;
}

export const DEFAULT_TMP_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LOG_RETENTION_DAYS = 14;

export function scanTmp(_paths: string[] = []): ScanTmpResult[] {
  return [];
}

export function rotateLogs(_paths: string[] = []): RotateLogsResult[] {
  return [];
}

export function scanDataVault(_paths: string[] = []): ScanDataVaultResult[] {
  return [];
}

export function runJanitor(): JanitorReport {
  return {
    scanned_tmp: [],
    rotated_logs: [],
    scanned_data_vault: [],
    removed: 0,
  };
}
