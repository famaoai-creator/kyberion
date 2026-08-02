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
      'src/app/api/message/route.ts',
      'src/app/api/voice/listen-once/route.ts',
      'src/app/api/voice/stop/route.ts',
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
      'src/app/api/events/route.ts',
      'src/app/api/voice/status/route.ts',
    ]) {
      const source = fs.readFileSync(path.join(appDir, route), 'utf8');
      expect(source, route).not.toMatch(/export (async )?function (POST|PUT|DELETE|PATCH)/);
    }
  });

  it('implements the CS-01 conversation core with the two-path failover', () => {
    const route = fs.readFileSync(path.join(appDir, 'src/app/api/message/route.ts'), 'utf8');
    expect(route).toContain('requireConciergeMutationAccess');
    // Primary path: voice-hub ingest with a bounded timeout so the UI never hangs.
    expect(route).toContain('/api/ingest-text');
    expect(route).toContain('AbortSignal.timeout');
    // Fallback path: lazy orchestrator import (no second daemon required).
    expect(route).toContain("import('@agent/core/channel-surface')");
    expect(route).toContain('runSurfaceMessageConversation');
    // Both paths failing must produce a loud, actionable 503 — never silence.
    expect(route).toContain("mode: 'unavailable'");
    expect(route).toContain('503');
  });

  it('streams summary changes over SSE with heartbeat and abort cleanup', () => {
    const route = fs.readFileSync(path.join(appDir, 'src/app/api/events/route.ts'), 'utf8');
    expect(route).toContain('buildCeoSurfaceSummary');
    expect(route).toContain('text/event-stream');
    expect(route).toContain('heartbeat');
    expect(route).toContain("addEventListener('abort'");
  });

  it('replaces window.prompt and 30 s summary polling on the home page', () => {
    const page = fs.readFileSync(path.join(appDir, 'src/app/page.tsx'), 'utf8');
    expect(page).not.toContain('window.prompt');
    expect(page).toContain("t('home.change_send')");
    expect(page).toContain("new EventSource('/api/events')");
  });

  it('mounts the conversation dock through the shared i18n mechanism', () => {
    const dock = fs.readFileSync(path.join(appDir, 'src/app/conversation-dock.tsx'), 'utf8');
    const layout = fs.readFileSync(path.join(appDir, 'src/app/layout.tsx'), 'utf8');
    const messages = fs.readFileSync(path.join(appDir, 'src/lib/messages.json'), 'utf8');
    expect(layout).toContain('ConversationDock');
    expect(dock).toContain('useConciergeI18n');
    expect(dock).toContain("fetch('/api/message'");
    // The four UX-contract conversation shapes render as labeled cards.
    expect(dock).toContain('execution_preview');
    expect(messages).toContain('dock.shape.clarification');
    expect(messages).toContain('dock.shape.execution_preview');
    expect(messages).toContain('dock.shape.status_summary');
    expect(messages).toContain('dock.shape.delivery_summary');
    // ceo-ux.md: no internal execution vocabulary in dock copy.
    expect(dock).not.toMatch(/actuator|pipeline|ADF/i);
  });

  it('implements the CS-02 voice tiers with guarded proxies and Tier-0 fallback', () => {
    const status = fs.readFileSync(path.join(appDir, 'src/app/api/voice/status/route.ts'), 'utf8');
    const listenOnce = fs.readFileSync(
      path.join(appDir, 'src/app/api/voice/listen-once/route.ts'),
      'utf8'
    );
    const stop = fs.readFileSync(path.join(appDir, 'src/app/api/voice/stop/route.ts'), 'utf8');
    const hook = fs.readFileSync(path.join(appDir, 'src/lib/use-voice.ts'), 'utf8');
    const dock = fs.readFileSync(path.join(appDir, 'src/app/conversation-dock.tsx'), 'utf8');
    const messages = fs.readFileSync(path.join(appDir, 'src/lib/messages.json'), 'utf8');

    // Tier detection: bounded /health probe that degrades to available:false
    // instead of throwing — the dock must work with voice-hub down.
    expect(status).toContain('/health');
    expect(status).toContain('AbortSignal.timeout');
    expect(status).toContain('available: false');
    // The mutating proxies forward to the real voice-hub endpoints and are
    // guarded like every other write route.
    expect(listenOnce).toContain('requireConciergeMutationAccess');
    expect(listenOnce).toContain('/api/listen-once');
    expect(listenOnce).toContain('AbortSignal.timeout');
    expect(stop).toContain('requireConciergeMutationAccess');
    expect(stop).toContain('/api/stop-speaking');
    // Tier 0 lives in the hook: browser SpeechRecognition (webkit fallback)
    // for input, speechSynthesis for output, persisted output preference.
    expect(hook).toContain('webkitSpeechRecognition');
    expect(hook).toContain('speechSynthesis');
    expect(hook).toContain("fetch('/api/voice/status')");
    expect(hook).toContain('localStorage');
    expect(hook).toContain("fetch('/api/voice/listen-once'");
    expect(hook).toContain("fetch('/api/voice/stop'");
    // The dock wires the hook: mic button with pressed state, and voice-hub
    // replies are never spoken twice by the browser.
    expect(dock).toContain('useVoice');
    expect(dock).toContain('aria-pressed');
    expect(dock).toContain("payload.mode === 'voice-hub'");
    expect(dock).toContain('notifyServerSpeech');
    expect(messages).toContain('dock.voice.no_transcript');
    expect(messages).toContain('dock.voice.stop_speaking');
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
