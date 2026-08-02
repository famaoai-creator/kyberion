/* eslint-disable no-restricted-imports */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('concierge surface contract', () => {
  it('declares its role tagline in the layout header', () => {
    const layout = fs.readFileSync(path.join(appDir, 'src/app/layout.tsx'), 'utf8');
    const header = fs.readFileSync(path.join(appDir, 'src/app/concierge-header.tsx'), 'utf8');
    expect(layout).toContain('ConciergeHeader');
    expect(header).toContain("t('header.tagline')");
    expect(header).toContain("locale === 'ja' ? '秘書室' : 'Concierge'");
  });

  it('guards every mutating route with the shared surface mutation guard', () => {
    const mutatingRoutes = [
      'src/app/api/approvals/[id]/route.ts',
      'src/app/api/outcomes/[id]/route.ts',
      'src/app/api/setup/route.ts',
    ];
    for (const route of mutatingRoutes) {
      const source = fs.readFileSync(path.join(appDir, route), 'utf8');
      expect(source, route).toContain('requireConciergeMutationAccess');
    }
  });

  it('exposes the personal-secretary onboarding controls', () => {
    const setupPage = fs.readFileSync(path.join(appDir, 'src/app/setup/page.tsx'), 'utf8');
    const setupRoute = fs.readFileSync(path.join(appDir, 'src/app/api/setup/route.ts'), 'utf8');
    const messages = fs.readFileSync(path.join(appDir, 'src/lib/messages.json'), 'utf8');
    expect(setupPage).toContain("t('setup.save_profile')");
    expect(setupPage).toContain("t('setup.image_label')");
    expect(setupPage).toContain("t('setup.save_voice')");
    expect(setupPage).toContain('getUserMedia');
    expect(setupPage).toContain('MediaRecorder');
    expect(setupPage).toContain("t('setup.capture_avatar')");
    expect(setupPage).toContain("t('setup.camera_fallback')");
    expect(setupPage).toContain("t('setup.services_title')");
    expect(setupPage).toContain("t('setup.management_title')");
    expect(setupPage).toContain("action: 'save_management'");
    expect(messages).toContain('プロフィールと接続準備を保存');
    expect(messages).toContain('アバター画像');
    expect(messages).toContain('音声プロフィールを登録');
    expect(messages).toContain('撮影してアバターを作成');
    expect(messages).toContain('マイクで録音');
    expect(setupRoute).toContain('applyBrowserOnboarding');
    expect(setupRoute).toContain('writeTenantProfile');
    expect(setupRoute).toContain('listAgentIdentities');
    expect(setupRoute).toContain("action === 'save_management'");
    expect(setupRoute).toContain('saveBrowserOnboardingVoiceSample');
    expect(setupRoute).toContain("action === 'avatar'");
  });

  it('keeps GET routes free of mutations (summary/theme are read-only)', () => {
    for (const route of [
      'src/app/api/summary/route.ts',
      'src/app/api/theme/route.ts',
      'src/app/api/response-status/route.ts',
    ]) {
      const source = fs.readFileSync(path.join(appDir, route), 'utf8');
      expect(source, route).not.toMatch(/export (async )?function (POST|PUT|DELETE|PATCH)/);
    }
  });

  it('surfaces bounded response waiting with a recovery-oriented status panel', () => {
    const page = fs.readFileSync(path.join(appDir, 'src/app/page.tsx'), 'utf8');
    const route = fs.readFileSync(
      path.join(appDir, 'src/app/api/response-status/route.ts'),
      'utf8'
    );
    expect(page).toContain("t('home.response_title')");
    expect(page).toContain('/api/response-status');
    expect(route).toContain('listActiveDelegatedTaskRecords');
    expect(route).toContain('peekPersistedDelegationChildrenRegistry');
    expect(route).toContain('staleChildCount');
  });
});
