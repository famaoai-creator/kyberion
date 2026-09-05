import { describe, expect, it } from 'vitest';
import {
  clearDesktopPromotionTransaction,
  loadDesktopPromotionTransactionAtPath,
  reconcileDesktopPromotionTransaction,
  writeDesktopPromotionTransaction,
} from './desktop-promotion-transaction.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync } from './secure-io.js';

describe('desktop promotion transaction path boundary', () => {
  it('rejects marker paths outside the repository during reconciliation', () => {
    const procedureId = `path-boundary-${Date.now()}`;
    try {
      writeDesktopPromotionTransaction({
        schema_version: 'desktop-promotion-transaction.v1',
        status: 'prepared',
        procedure_id: procedureId,
        pipeline_path: '/tmp/desktop-promotion-outside-pipeline.json',
        catalog_path: '/tmp/desktop-promotion-outside-catalog.json',
        pipeline_sha256: 'a'.repeat(64),
        catalog_sha256: 'b'.repeat(64),
      });

      expect(() => reconcileDesktopPromotionTransaction(procedureId)).toThrow(
        /RESOURCE_PATH_SCOPE|outside the repository/i
      );
    } finally {
      clearDesktopPromotionTransaction(procedureId);
    }
  });

  it('validates the persisted marker and binds it to the procedure id', () => {
    const procedureId = `loader-${Date.now()}`;
    const markerPath = pathResolver.shared(
      `runtime/state/desktop-promotion-transactions/${procedureId}.json`
    );
    try {
      writeDesktopPromotionTransaction({
        schema_version: 'desktop-promotion-transaction.v1',
        status: 'prepared',
        procedure_id: procedureId,
        pipeline_path: pathResolver.rootResolve('active/shared/tmp/pipeline.json'),
        catalog_path: pathResolver.rootResolve('active/shared/tmp/catalog.json'),
        pipeline_sha256: 'a'.repeat(64),
        catalog_sha256: 'b'.repeat(64),
      });
      expect(loadDesktopPromotionTransactionAtPath(markerPath, procedureId).procedure_id).toBe(
        procedureId
      );
      expect(() => loadDesktopPromotionTransactionAtPath(markerPath, 'other')).toThrow(
        'DESKTOP_PROMOTION_SCOPE_MISMATCH'
      );
    } finally {
      clearDesktopPromotionTransaction(procedureId);
    }
  });

  it('rejects a directory at the persisted marker path', () => {
    const procedureId = `directory-${Date.now()}`;
    const markerPath = pathResolver.shared(
      `runtime/state/desktop-promotion-transactions/${procedureId}.json`
    );
    try {
      safeMkdir(markerPath, { recursive: true });
      expect(() => loadDesktopPromotionTransactionAtPath(markerPath, procedureId)).toThrow(
        'transaction must be a regular file'
      );
    } finally {
      safeRmSync(markerPath, { recursive: true, force: true });
      clearDesktopPromotionTransaction(procedureId);
    }
  });
});
