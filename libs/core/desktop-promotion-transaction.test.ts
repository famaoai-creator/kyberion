import { describe, expect, it } from 'vitest';
import {
  clearDesktopPromotionTransaction,
  reconcileDesktopPromotionTransaction,
  writeDesktopPromotionTransaction,
} from './desktop-promotion-transaction.js';

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
        pipeline_sha256: 'pipeline',
        catalog_sha256: 'catalog',
      });

      expect(() => reconcileDesktopPromotionTransaction(procedureId)).toThrow(
        /RESOURCE_PATH_SCOPE|outside the repository/i
      );
    } finally {
      clearDesktopPromotionTransaction(procedureId);
    }
  });
});
