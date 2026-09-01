import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { pathResolver } from './path-resolver.js';
import { safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  buildOperatorRequestLogFromIntentResolution,
  getOperatorLearningDispatchRegistry,
  _resetOperatorLearningDispatchRegistryCacheForTests,
} from './operator-learning.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';

describe('operator-learning dispatch registry', () => {
  it('loads the governed default dispatch registry', () => {
    const registry = getOperatorLearningDispatchRegistry();
    expect(registry.version).toBe('1.0.0');
    expect(registry.rules.length).toBeGreaterThan(0);
  });

  it('can be extended through a registry file without code changes', () => {
    const overridePath = pathResolver.sharedTmp(
      'operator-learning-dispatch-registry-override.json'
    );
    const originalEnv = process.env.KYBERION_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH;
    const defaultRegistry = JSON.parse(
      safeReadFile(
        pathResolver.knowledge('product/governance/operator-learning-dispatch-registry.json'),
        { encoding: 'utf8' }
      ) as string
    );

    try {
      safeWriteFile(
        overridePath,
        `${JSON.stringify(
          {
            ...defaultRegistry,
            rules: [
              {
                rule_id: 'open-site-custom-navigation',
                priority: 999,
                match: { intent_ids: ['open-site'] },
                dispatch: {
                  recurring_task_candidate: ['site_navigation'],
                },
              },
              ...defaultRegistry.rules,
            ],
          },
          null,
          2
        )}\n`
      );

      process.env.KYBERION_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH = overridePath;
      _resetOperatorLearningDispatchRegistryCacheForTests();

      const packet = resolveIntentResolutionPacket('Open OpenAI docs');
      const log = buildOperatorRequestLogFromIntentResolution({
        packet,
        profileId: 'ceo-cto-hybrid',
        surface: 'terminal',
        receivedAt: '2026-04-29T11:00:00.000Z',
      });

      expect(log.signals.recurring_task_candidate).toContain('site_navigation');
      expect(log.signals.recurring_task_candidate?.[0]).toBe('site_navigation');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.KYBERION_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH;
      } else {
        process.env.KYBERION_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH = originalEnv;
      }
      _resetOperatorLearningDispatchRegistryCacheForTests();
    }
  });

  it('rejects a dispatch registry override that traverses a symbolic link', () => {
    const targetPath = pathResolver.sharedTmp('operator-learning-dispatch-registry-target.json');
    const linkedPath = pathResolver.sharedTmp('operator-learning-dispatch-registry-linked.json');
    try {
      safeWriteFile(targetPath, JSON.stringify({ version: '1.0.0', rules: [] }));
      fs.symlinkSync(targetPath, linkedPath);
      process.env.KYBERION_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH = linkedPath;
      _resetOperatorLearningDispatchRegistryCacheForTests();

      expect(() => getOperatorLearningDispatchRegistry()).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      safeRmSync(linkedPath, { force: true });
      safeRmSync(targetPath, { force: true });
      delete process.env.KYBERION_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH;
      _resetOperatorLearningDispatchRegistryCacheForTests();
    }
  });

  it('merges confidential and personal overlays in priority order', () => {
    const confidentialOverlayPath = pathResolver.sharedTmp(
      'operator-learning-dispatch-registry-confidential.json'
    );
    const personalOverlayPath = pathResolver.sharedTmp(
      'operator-learning-dispatch-registry-personal.json'
    );
    const originalConfidentialEnv =
      process.env.KYBERION_CONFIDENTIAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH;
    const originalPersonalEnv =
      process.env.KYBERION_PERSONAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH;

    try {
      safeWriteFile(
        confidentialOverlayPath,
        `${JSON.stringify(
          {
            version: '1.0.0',
            rules: [
              {
                rule_id: 'open-site-confidential-navigation',
                priority: 500,
                match: { intent_ids: ['open-site'] },
                dispatch: {
                  recurring_task_candidate: ['confidential_navigation'],
                },
              },
            ],
          },
          null,
          2
        )}\n`
      );
      safeWriteFile(
        personalOverlayPath,
        `${JSON.stringify(
          {
            version: '1.0.0',
            rules: [
              {
                rule_id: 'open-site-personal-navigation',
                priority: 999,
                match: { intent_ids: ['open-site'] },
                dispatch: {
                  recurring_task_candidate: ['personal_navigation'],
                },
              },
            ],
          },
          null,
          2
        )}\n`
      );

      process.env.KYBERION_CONFIDENTIAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH =
        confidentialOverlayPath;
      process.env.KYBERION_PERSONAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH = personalOverlayPath;
      _resetOperatorLearningDispatchRegistryCacheForTests();

      const packet = resolveIntentResolutionPacket('Open OpenAI docs');
      const log = buildOperatorRequestLogFromIntentResolution({
        packet,
        profileId: 'ceo-cto-hybrid',
        surface: 'terminal',
        receivedAt: '2026-04-29T11:05:00.000Z',
      });

      expect(log.signals.recurring_task_candidate).toEqual(
        expect.arrayContaining([
          'personal_navigation',
          'confidential_navigation',
          'browser_navigation',
        ])
      );
      expect(log.signals.recurring_task_candidate?.[0]).toBe('personal_navigation');
    } finally {
      if (originalConfidentialEnv === undefined) {
        delete process.env.KYBERION_CONFIDENTIAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH;
      } else {
        process.env.KYBERION_CONFIDENTIAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH =
          originalConfidentialEnv;
      }
      if (originalPersonalEnv === undefined) {
        delete process.env.KYBERION_PERSONAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH;
      } else {
        process.env.KYBERION_PERSONAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH =
          originalPersonalEnv;
      }
      _resetOperatorLearningDispatchRegistryCacheForTests();
    }
  });
});
