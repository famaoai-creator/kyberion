/**
 * MissionEvidenceDoc — typed JSON document under a mission's
 * `evidence/` directory.
 *
 * Many mission flows store one-shot policy / consent / capture state
 * in a single JSON file (voice-consent, transcript metadata, capture
 * receipts, ...). They all need the same plumbing: resolve the right
 * evidence dir, write through `secure-io`, optionally emit an
 * audit-chain entry. This module collapses that plumbing into one
 * helper so consumers don't reinvent the read/write/audit triad.
 *
 * Use it for **single-document state** (one record at a time). For
 * append-only streams use the action-item / audit-chain pattern.
 */

import * as path from 'node:path';
import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { auditChain } from './audit-chain.js';

export interface MissionEvidenceDocOptions<T> {
  /** Mission id whose evidence directory holds this document. */
  mission_id: string;
  /** Filename relative to the mission's `evidence/` dir (e.g. `voice-consent.json`). */
  filename: string;
  /** Agent label used in audit-chain entries; defaults to the filename stem. */
  agent_id?: string;
  /**
   * Optional shape validator run on read. Returns `true` to accept.
   * On `false` the doc is treated as unreadable (logged + null).
   */
  validate?: (doc: unknown) => doc is T;
}

export class MissionEvidenceDoc<T> {
  private readonly options: MissionEvidenceDocOptions<T>;

  constructor(options: MissionEvidenceDocOptions<T>) {
    this.options = options;
  }

  /** Absolute path to the document. */
  get filePath(): string {
    const evidenceDir =
      pathResolver.missionEvidenceDir(this.options.mission_id) ??
      pathResolver.rootResolve(
        `active/missions/confidential/${this.options.mission_id}/evidence`,
      );
    return path.join(evidenceDir, this.options.filename);
  }

  exists(): boolean {
    return safeExistsSync(this.filePath);
  }

  read(): T | null {
    if (!this.exists()) return null;
    try {
      const data = JSON.parse(safeReadFile(this.filePath, { encoding: 'utf8' }) as string) as unknown;
      if (this.options.validate && !this.options.validate(data)) {
        logger.warn(
          `[mission-evidence-doc] ${this.filePath} failed validator; ignoring`,
        );
        return null;
      }
      return data as T;
    } catch (err: any) {
      logger.warn(`[mission-evidence-doc] failed to parse ${this.filePath}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Write the document and optionally emit one audit-chain entry. The
   * `auditAction` is the load-bearing label (e.g. `voice_consent.grant`).
   * Returns the audit event id when one was recorded, or empty string.
   */
  write(
    record: T,
    audit?: { action: string; reason?: string; metadata?: Record<string, unknown> },
  ): { audit_event_id: string } {
    safeMkdir(path.dirname(this.filePath), { recursive: true });
    safeWriteFile(this.filePath, JSON.stringify(record, null, 2));
    if (!audit) return { audit_event_id: '' };
    const agentId = this.options.agent_id ?? this.options.filename.replace(/\.[^.]+$/, '');
    try {
      const entry = auditChain.record({
        agentId,
        action: audit.action,
        operation: this.options.mission_id,
        result: 'allowed',
        ...(audit.reason ? { reason: audit.reason } : {}),
        ...(audit.metadata ? { metadata: audit.metadata } : {}),
      });
      return { audit_event_id: entry.id };
    } catch (err: any) {
      logger.warn(`[mission-evidence-doc] audit emission failed: ${err?.message ?? err}`);
      return { audit_event_id: '' };
    }
  }
}
