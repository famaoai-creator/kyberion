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
      'src/app/api/notification-preferences/route.ts',
      'src/app/api/message/route.ts',
      'src/app/api/voice/listen-once/route.ts',
      'src/app/api/voice/stop/route.ts',
      'src/app/api/hygiene/[id]/route.ts',
      'src/app/api/ingest/route.ts',
      'src/app/api/memory-queue/[id]/route.ts',
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
      'src/app/api/hygiene/route.ts',
      'src/app/api/outcomes/[id]/preview/route.ts',
      'src/app/api/memory-queue/route.ts',
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

  it('renders actionable setup diagnostics that jump to in-page sections (CS-03)', () => {
    const setupRoute = fs.readFileSync(path.join(appDir, 'src/app/api/setup/route.ts'), 'utf8');
    const setupPage = fs.readFileSync(path.join(appDir, 'src/app/setup/page.tsx'), 'utf8');
    const messages = fs.readFileSync(path.join(appDir, 'src/lib/messages.json'), 'utf8');
    // Every incomplete item carries a machine-actionable navigate descriptor.
    expect(setupRoute).toContain('diagnostics');
    expect(setupRoute).toContain("type: 'navigate'");
    expect(setupRoute).toContain("target: '#setup-");
    // The page renders the checklist and attention items jump to their section.
    expect(setupPage).toContain("t('setup.readiness_title')");
    expect(setupPage).toContain('scrollIntoView');
    for (const anchor of [
      'setup-profile',
      'setup-media',
      'setup-services',
      'setup-notifications',
    ]) {
      expect(setupPage).toContain(`id="${anchor}"`);
    }
    // ceo-ux.md: items with an in-app section no longer print shell commands,
    // and pipeline IDs are not exposed as UI copy.
    expect(setupPage).not.toContain('setup.device_command');
    expect(setupPage).not.toContain('setup.pipeline');
    expect(setupRoute).not.toContain('pnpm surfaces:status');
    expect(setupRoute).not.toContain('schedule-summary-and-coordination');
    // Honest degradation: the reasoning backend has no in-app fix, so the
    // terminal command survives — as guidance-first, visually secondary copy.
    expect(setupRoute).toContain('pnpm reasoning:setup');
    expect(setupPage).toContain("'setup.reasoning_guidance'");
    expect(setupPage).toContain("t('setup.reasoning_command_hint'");
    expect(setupPage).toContain('readiness-command');
    expect(messages).toContain('整備状況');
  });

  it('routes notification channel settings through the guarded preferences API (CS-03)', () => {
    const route = fs.readFileSync(
      path.join(appDir, 'src/app/api/notification-preferences/route.ts'),
      'utf8'
    );
    const setupPage = fs.readFileSync(path.join(appDir, 'src/app/setup/page.tsx'), 'utf8');
    const messages = fs.readFileSync(path.join(appDir, 'src/lib/messages.json'), 'utf8');
    // Preferences load/save reuse the @agent/core operator-notifications
    // helpers under the sovereign_concierge execution context.
    expect(route).toContain('loadNotificationPreferences');
    expect(route).toContain('saveNotificationPreferences');
    expect(route).toContain("withExecutionContext('sovereign_concierge'");
    expect(route).toContain('withSensitivePathMediation');
    // Channel candidates come from the shared channel directory, and the
    // POST validates the surface against it before saving.
    expect(route).toContain('listChannelDirectoryEntries');
    expect(route).toContain('requireConciergeMutationAccess');
    expect(route).not.toMatch(/export (async )?function (PUT|DELETE|PATCH)/);
    // The setup page exposes the section and reports it in the checklist.
    expect(setupPage).toContain("t('setup.notifications_title')");
    expect(setupPage).toContain("fetch('/api/notification-preferences'");
    expect(messages).toContain('通知設定を保存');
  });

  it('presents stalled missions as inquiry cards where only the human decides (CS-03)', () => {
    const listRoute = fs.readFileSync(path.join(appDir, 'src/app/api/hygiene/route.ts'), 'utf8');
    const decisionRoute = fs.readFileSync(
      path.join(appDir, 'src/app/api/hygiene/[id]/route.ts'),
      'utf8'
    );
    const server = fs.readFileSync(path.join(appDir, 'src/lib/hygiene-server.ts'), 'utf8');
    const page = fs.readFileSync(path.join(appDir, 'src/app/page.tsx'), 'utf8');
    const messages = fs.readFileSync(path.join(appDir, 'src/lib/messages.json'), 'utf8');

    // Classification comes from the shared hygiene report; the GET is pure
    // read and never touches the mission controller.
    expect(server).toContain('collectMissionHygieneReport');
    expect(listRoute).toContain('listHygieneInquiries');
    expect(listRoute).not.toContain('mission_controller');
    // The report's remediation strings carry CLI commands — they must never
    // reach the client (ceo-ux.md: no internal execution vocabulary).
    expect(server).not.toContain('finding.recommendation');
    expect(server).not.toContain('pnpm');

    // Mission state changes go exclusively through the mission controller
    // (repo invariant), with the controller role and honest exit handling.
    expect(decisionRoute).toContain('requireConciergeMutationAccess');
    expect(decisionRoute).toContain('dist/scripts/mission_controller.js');
    expect(decisionRoute).toContain('safeExecResult');
    expect(decisionRoute).toContain("MISSION_ROLE: 'mission_controller'");
    // Human-only gate: the route accepts nothing but an explicit start/cancel
    // decision from the request body, validates the mission is actually in
    // the hygiene report, and there is no scheduler or auto-invocation path.
    expect(decisionRoute).toContain("['start', 'cancel'] as const");
    expect(decisionRoute).toContain('findHygieneInquiry');
    expect(decisionRoute).not.toMatch(/setInterval|setTimeout/);
    // Exit code 0 alone is not success — the transition is verified on disk.
    expect(decisionRoute).toContain('readMissionStatus');

    // The pane uses an inline confirm step, never the blocking browser dialog.
    expect(page).toContain("t('hygiene.title')");
    expect(page).toContain("'hygiene.confirm_start'");
    expect(page).toContain("'hygiene.confirm_cancel'");
    expect(page).not.toContain('window.confirm');
    expect(messages).toContain('ご判断ください(停滞中のご依頼)');
    expect(messages).toContain('開始する');
    expect(messages).toContain('取りやめる');
  });

  it('renders inline artifact previews only from the entry-recorded paths (CS-03 / SU-03)', () => {
    const route = fs.readFileSync(
      path.join(appDir, 'src/app/api/outcomes/[id]/preview/route.ts'),
      'utf8'
    );
    const page = fs.readFileSync(path.join(appDir, 'src/app/page.tsx'), 'utf8');
    const messages = fs.readFileSync(path.join(appDir, 'src/lib/messages.json'), 'utf8');

    // Path safety: the entry is looked up server-side and only its own
    // artifact_paths are opened — no client-supplied path ever reaches a read.
    expect(route).toContain('listInboxEntries');
    expect(route).toContain('artifact_paths');
    expect(route).not.toContain('searchParams');
    // All reads go through secure-io under the concierge execution context;
    // node:fs never appears (repo invariant).
    expect(route).toContain("withExecutionContext('sovereign_concierge'");
    expect(route).toContain('withSensitivePathMediation');
    expect(route).not.toMatch(/from ['"]node:fs['"]|require\(['"]node:fs['"]\)/);
    // Bounded output: file count cap, text truncation, and an image size lid.
    expect(route).toContain('MAX_FILES');
    expect(route).toContain('MAX_TEXT_CHARS');
    expect(route).toContain('MAX_IMAGE_BYTES');

    // The outcome card fetches on demand and degrades politely for formats
    // it cannot show inline.
    expect(page).toContain("t('home.preview')");
    expect(page).toContain('/preview');
    expect(page).toContain('data_uri');
    expect(messages).toContain('このファイル形式はここでは表示できません');
    expect(messages).toContain('冒頭のみ表示');
  });

  it('runs document intake as an explicit one-shot ingest ceremony (CS-03)', () => {
    const route = fs.readFileSync(path.join(appDir, 'src/app/api/ingest/route.ts'), 'utf8');
    const page = fs.readFileSync(path.join(appDir, 'src/app/ingest/page.tsx'), 'utf8');
    const header = fs.readFileSync(path.join(appDir, 'src/app/concierge-header.tsx'), 'utf8');
    const messages = fs.readFileSync(path.join(appDir, 'src/lib/messages.json'), 'utf8');

    // The ceremony always goes through the built DA-05 ingest CLI with an
    // explicit identity — anonymous ingests are refused by the script itself.
    expect(route).toContain('requireConciergeMutationAccess');
    expect(route).toContain('dist/scripts/ingest.js');
    expect(route).toContain('--ingested-by');
    expect(route).toContain('safeExecResult');
    expect(route).toContain('--dry-run');
    // Uploads stage under active/shared/tmp (repo temp-file invariant) and are
    // cleaned up best-effort; node:fs never appears (repo invariant).
    expect(route).toContain('active/shared/tmp');
    expect(route).toContain('sharedTmp(');
    expect(route).toContain('safeRmSync');
    expect(route).not.toMatch(/from ['"]node:fs['"]|require\(['"]node:fs['"]\)/);
    // One explicit upload per ceremony — no scheduler, no auto-retry timer
    // (the deliberate absence of a watch/auto-ingest mode mirrors the CLI).
    expect(route).not.toMatch(/setInterval\(|setTimeout\(/);
    // Exit code 0 alone is not success: the route reads the ceremony's own
    // verdict lines before claiming anything.
    expect(route).toContain('[ingest] DRY RUN');
    expect(route).toContain('[ingest] committed ');
    expect(route).toContain('[ingest] NOT committed');
    // Tenant candidates are validated against the tenant registry.
    expect(route).toContain('listTenantProfileSlugs');

    // The page is a dedicated form: drop zone + picker, tenant select, and a
    // preview-first default (dry-run ON) with an explicit second commit step.
    expect(page).toContain('onDrop');
    expect(page).toContain("t('ingest.drop_hint')");
    expect(page).toContain('setDryRun] = React.useState(true)');
    expect(page).toContain("t('ingest.commit_after_preview')");
    expect(header).toContain("t('header.ingest')");
    expect(messages).toContain('資料の取込');
    expect(messages).toContain('まず内容を確認する');
  });

  it('presents the memory promotion queue for human approval only (CS-03)', () => {
    const listRoute = fs.readFileSync(
      path.join(appDir, 'src/app/api/memory-queue/route.ts'),
      'utf8'
    );
    const decisionRoute = fs.readFileSync(
      path.join(appDir, 'src/app/api/memory-queue/[id]/route.ts'),
      'utf8'
    );
    const page = fs.readFileSync(path.join(appDir, 'src/app/page.tsx'), 'utf8');
    const messages = fs.readFileSync(path.join(appDir, 'src/lib/messages.json'), 'utf8');

    // The list is a pure read over the shared promotion queue, filtered to
    // undecided candidates; it never touches the mission controller.
    expect(listRoute).toContain('listMemoryPromotionCandidates');
    expect(listRoute).toContain("status === 'queued'");
    expect(listRoute).not.toContain('mission_controller');

    // Decisions go exclusively through scripts/mission_controller.ts (repo
    // invariant), with the controller role and honest exit handling.
    expect(decisionRoute).toContain('requireConciergeMutationAccess');
    expect(decisionRoute).toContain('dist/scripts/mission_controller.js');
    expect(decisionRoute).toContain('memory-approve');
    expect(decisionRoute).toContain('memory-reject');
    expect(decisionRoute).toContain("MISSION_ROLE: 'mission_controller'");
    expect(decisionRoute).toContain('safeExecResult');
    // The candidate must exist and still be pending before anything runs, and
    // exit code 0 alone is not success — the transition is verified on disk.
    expect(decisionRoute).toContain('loadMemoryPromotionCandidate');
    expect(decisionRoute).toContain("candidate.status !== 'queued'");
    expect(decisionRoute).toContain('after?.status !== expected');
    expect(decisionRoute).not.toMatch(/setInterval\(|setTimeout\(/);
    for (const source of [listRoute, decisionRoute]) {
      expect(source).not.toMatch(/from ['"]node:fs['"]|require\(['"]node:fs['"]\)/);
    }

    // The pane uses inline confirm and translated plain-language labels — the
    // internal kind/tier codes never render verbatim.
    expect(page).toContain("t('memory.title')");
    expect(page).toContain('memory.kind.');
    expect(page).toContain('memory.tier.');
    expect(page).toContain("'memory.confirm_approve'");
    expect(page).toContain("'memory.confirm_reject'");
    expect(page).not.toContain('window.confirm');
    expect(messages).toContain('記憶にしてよいか(学びの承認)');
    expect(messages).toContain('コツとして残したい学び');
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
