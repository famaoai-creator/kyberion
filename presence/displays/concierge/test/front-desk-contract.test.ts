/* eslint-disable no-restricted-imports */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(appDir, relativePath), 'utf8');
}

describe('FD-00c/FD-01c front-desk contract (concierge)', () => {
  it('mounts the shared rail alongside the existing layout fixtures', () => {
    const layout = read('src/app/layout.tsx');
    expect(layout).toContain('FrontDeskRail');
    expect(layout).toContain('ConciergeHeader');
    expect(layout).toContain('ConversationDock');
    expect(layout).toContain('CommandPalette');
  });

  it('reads front-desk ports server-side in layout.tsx and passes them to CommandPalette, never hardcoded', () => {
    const layout = read('src/app/layout.tsx');
    const palette = read('src/app/command-palette.tsx');
    expect(layout).toContain('readFrontDeskSurfacePorts');
    expect(layout).toContain('frontDeskPorts={frontDeskPorts}');
    // The palette builds its 3 cross-surface hrefs from the prop, not a
    // hardcoded port literal (plan §2.6: "ポート番号をハードコードしない").
    expect(palette).not.toContain('3031');
    expect(palette).not.toContain('3050');
    expect(palette).toContain('frontDeskPorts');
  });

  it('drops the header nav links now that the rail carries them', () => {
    const header = read('src/app/concierge-header.tsx');
    expect(header).not.toContain('href="/ingest"');
    expect(header).not.toContain('href="/setup"');
    // The header still declares the surface identity contract.
    expect(header).toContain("t('header.tagline')");
    expect(header).toContain("locale === 'ja' ? '秘書室' : 'Concierge'");
  });

  it('renders the rail without target=_blank, raw loopback URLs, or emoji, and marks the current item', () => {
    const rail = read('src/app/front-desk-rail.tsx');
    expect(rail).not.toContain('target="_blank"');
    expect(rail).not.toContain("target={'_blank'}");
    expect(rail).not.toContain('127.0.0.1');
    // eslint-disable-next-line no-misleading-character-class
    expect(rail).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/u);
    expect(rail).toContain('aria-current');
    // 資料の取込 (ingest) stays reachable from the rail, labelled with the
    // existing header.ingest key, now that the header dropped its own link.
    expect(rail).toContain("t('header.ingest')");
  });

  it('guards /api/me and /api/front-desk/nav with the shared viewer resolver and no-store', () => {
    const me = read('src/app/api/me/route.ts');
    const nav = read('src/app/api/front-desk/nav/route.ts');
    for (const route of [me, nav]) {
      expect(route).toContain('resolveConciergeViewer');
      expect(route).toMatch(/resolved\.response/);
      expect(route).toContain('no-store');
    }
    // The tenant query param may only narrow — it is passed through as
    // `requestedTenant`, never used to widen the server-resolved scope.
    expect(me).toContain("searchParams.get('tenant')");
    expect(me).toContain('requestedTenant');
    expect(me).not.toContain('tenantSlugs: ');
  });

  it('FD-04: `/` renders the 決める queue from front_desk decide_* vocabulary, defers client-side only, and never blocks on window dialogs', () => {
    const page = read('src/app/page.tsx');
    const decideView = read('src/lib/decide-view.ts');

    // Header row: h1 = nav_decide, lead paragraph = decide_lead, filter chips
    // built from decide_filter_all + presentKinds (plan §2.1/FD-04).
    expect(page).toContain("frontDeskText('nav_decide', locale)");
    expect(page).toContain("frontDeskText('decide_lead', locale)");
    expect(page).toContain("frontDeskText('decide_filter_all', locale)");
    expect(page).toContain('presentKinds(countsByKind)');
    expect(page).toContain('groupDecideQueue(');
    expect(page).toContain('deriveCardFields(');

    // Per-kind action labels are the front_desk:decide_* keys via
    // frontDeskText, not hardcoded strings or the old home.* pane labels.
    expect(page).toContain("frontDeskText('decide_approve', locale)");
    expect(page).toContain("frontDeskText('decide_reject', locale)");
    expect(page).toContain("frontDeskText('decide_continue', locale)");
    expect(page).toContain("frontDeskText('decide_stop', locale)");
    expect(page).toContain("frontDeskText('decide_remember', locale)");
    expect(page).toContain("frontDeskText('decide_forget', locale)");
    expect(page).toContain("frontDeskText('decide_receive', locale)");
    expect(page).toContain("frontDeskText('decide_return', locale)");
    expect(page).toContain("frontDeskText('decide_later', locale)");
    expect(page).toContain("frontDeskText('decide_empty', locale)");
    expect(page).toContain("frontDeskText('decide_deferred', locale");
    expect(page).toContain("frontDeskText('decide_undefer', locale)");
    expect(page).toContain("frontDeskText('decide_by', locale");

    // decide_by ("決める人") comes from the shared identity contract, not a
    // hardcoded name — same shape as front-desk-rail.tsx's /api/me fetch.
    expect(page).toContain('fetch(`/api/me');
    expect(page).toContain('fetch(`/api/front-desk/nav');
    expect(page).toContain('role_labels');

    // decide_later is client-side only: the handlers that move an id into
    // `deferredIds` never call fetch(), and the deferred section persists to
    // localStorage rather than the server.
    const deferItemBody = page.slice(
      page.indexOf('const deferItem = React.useCallback'),
      page.indexOf('const undeferItem = React.useCallback')
    );
    const undeferItemBody = page.slice(
      page.indexOf('const undeferItem = React.useCallback'),
      page.indexOf('const [kindFilter,')
    );
    expect(deferItemBody).not.toContain('fetch(');
    expect(undeferItemBody).not.toContain('fetch(');
    expect(page).toContain('front-desk.deferred');
    expect(page).not.toContain('window.prompt');
    expect(page).not.toContain('window.confirm');

    // Mission ids never reach the human-facing card copy (ceo-ux.md §6).
    expect(page).not.toMatch(/\bmission_id\}\s*·/);

    // The pure grouping/field-mapping helper never imports I/O or calls
    // `t()`/`frontDeskText()` itself — only a type-only import of the
    // vocabulary key union, so the caller owns every translation.
    expect(decideView).not.toMatch(/from ['"]node:fs['"]/);
    expect(decideView).not.toContain('frontDeskText(');
    expect(decideView).not.toMatch(/[^\w.]t\(['"]/);
    expect(decideView).toContain("import type { FrontDeskMessageKey } from './i18n'");
    expect(decideView).toContain('export function groupDecideQueue');
    expect(decideView).toContain('export function deriveCardFields');
  });

  it('FD-06: /setup redirects to /settings, keeping the #hash for existing deep links', () => {
    const setup = read('src/app/setup/page.tsx');
    expect(setup).toContain("redirect('/settings')");
  });

  it('FD-06: /settings renders the 7 settings_nav_* sections, keeps all 8 legacy anchors, and never hardcodes a port or opens a new tab', () => {
    const settings = read('src/app/settings/page.tsx');
    const palette = read('src/app/command-palette.tsx');

    // FD-06 file split (KP gate: max-file-lines): each card's JSX moved out
    // of settings/page.tsx into its own file under settings/sections/. The
    // page still owns state, data loading, and handlers — see
    // test/concierge-contract.test.ts for the section-local literal checks.
    const sectionFiles = [
      'ProfileSection.tsx',
      'MembersSection.tsx',
      'ServicesSection.tsx',
      'VoiceSection.tsx',
      'NotificationsSection.tsx',
      'PluginsSection.tsx',
      'AdvancedSection.tsx',
    ];
    const sections = Object.fromEntries(
      sectionFiles.map((file) => [file, read(`src/app/settings/sections/${file}`)])
    );
    // Every literal that used to live directly in page.tsx must still exist
    // somewhere in the settings feature (page.tsx + its section files).
    const wholeFeature = settings + Object.values(sections).join('\n');

    const navLabelFiles: Record<string, string> = {
      settings_nav_profile: 'ProfileSection.tsx',
      settings_nav_members: 'MembersSection.tsx',
      settings_nav_services: 'ServicesSection.tsx',
      settings_nav_voice: 'VoiceSection.tsx',
      settings_nav_notifications: 'NotificationsSection.tsx',
      settings_nav_plugins: 'PluginsSection.tsx',
      settings_nav_advanced: 'AdvancedSection.tsx',
    };
    for (const [key, file] of Object.entries(navLabelFiles)) {
      expect(sections[file]).toContain(`frontDeskText('${key}', locale)`);
    }

    const anchorFiles: Record<string, string> = {
      'setup-profile': 'ProfileSection.tsx',
      'setup-management': 'AdvancedSection.tsx',
      'setup-media': 'VoiceSection.tsx',
      'setup-services': 'ServicesSection.tsx',
      'setup-notifications': 'NotificationsSection.tsx',
      'setup-plugins': 'PluginsSection.tsx',
      'setup-governance': 'AdvancedSection.tsx',
      'setup-operations': 'AdvancedSection.tsx',
    };
    for (const [anchor, file] of Object.entries(anchorFiles)) {
      expect(sections[file]).toContain(`id="${anchor}"`);
    }

    // No hardcoded surface port in client code (plan §2.6) — the
    // chronos-mirror-v2 link comes from /api/front-desk/links.
    expect(settings).toContain("fetch('/api/front-desk/links'");
    expect(wholeFeature).not.toContain('3000');
    expect(wholeFeature).not.toContain('3031');
    expect(wholeFeature).not.toContain('3050');

    expect(wholeFeature).not.toContain('target="_blank"');
    expect(wholeFeature).not.toContain("target={'_blank'}");
    // No decorative emoji (the pre-existing readiness "✓" glyph, U+2713, is a
    // status indicator carried over unchanged from setup/page.tsx, not new
    // decorative copy — excluded from this range rather than the range
    // being widened to legitimize it).
    // eslint-disable-next-line no-misleading-character-class
    expect(wholeFeature).not.toMatch(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{2712}\u{2714}-\u{27BF}\u{2190}-\u{21FF}]/u
    );

    // The palette's onboarding entries now point at /settings, not /setup.
    expect(palette).not.toContain("href: '/setup'");
    expect(palette).not.toContain("'/setup#");
    expect(palette).toContain("href: '/settings'");
  });

  it('FD-10: re-ports 声と話し方 voice selection, the accountable-agents list, and training assignment into their split section files', () => {
    const settings = read('src/app/settings/page.tsx');
    const voiceSection = read('src/app/settings/sections/VoiceSection.tsx');
    const membersSection = read('src/app/settings/sections/MembersSection.tsx');
    const useVoiceSelection = read('src/lib/use-voice-selection.ts');
    const useTrainingAssignments = read('src/lib/use-training-assignments.ts');
    const voiceSelectionRoute = read('src/app/api/voice/selection/route.ts');
    const trainingCatalogRoute = read('src/app/api/training/catalog/route.ts');
    const trainingAssignmentsRoute = read('src/app/api/training/assignments/route.ts');

    // 声と話し方: TTS engine / STT backend / input device selection lives in
    // VoiceSection.tsx; the fetch/save calls live in the use-voice-selection
    // hook the page wires in.
    expect(voiceSection).toContain('voiceSelection');
    expect(voiceSection).toContain("t('dock.voice.backend')");
    expect(voiceSection).toContain("t('dock.voice.auto')");
    expect(useVoiceSelection).toContain("fetch('/api/voice/selection'");
    expect(useVoiceSelection).toContain("method: 'POST'");
    expect(settings).toContain('useVoiceSelection');
    expect(voiceSelectionRoute).toContain('requireConciergeMutationAccess');

    // 組織とメンバー: accountable agents render by display name + accountable
    // member only — the raw nhi_id must never reach the rendered copy (plan
    // §2.5 principle 6). `agent.nhi_id` is still used as the React `key`
    // prop (never rendered as visible text), so only the JSX-text form
    // (`>{agent.nhi_id}<`) is asserted absent.
    expect(membersSection).toContain('durable_identities');
    expect(membersSection).toContain('agent.display_name');
    expect(membersSection).not.toMatch(/>\s*\{agent\.nhi_id\}\s*</);

    // HT-05 training-track assignment: tracks come from the governed
    // catalog (never hardcoded track titles), assignment posts to
    // /api/training/assignments, and only an owner may assign (server-side).
    expect(membersSection).toContain('trainingTracks');
    expect(membersSection).toContain('onAssignTraining');
    expect(useTrainingAssignments).toContain("fetch('/api/training/catalog'");
    expect(useTrainingAssignments).toContain("fetch('/api/training/assignments'");
    expect(useTrainingAssignments).toContain("method: 'POST'");
    expect(trainingCatalogRoute).toContain('resolveConciergeViewer');
    expect(trainingAssignmentsRoute).toContain('requireConciergeMutationAccess');
    expect(trainingAssignmentsRoute).toContain("!== 'owner'");
  });

  it('HT-06 (i18n gate): MembersSection/VoiceSection use vocabulary keys, never the kanji-only stand-ins', () => {
    const membersSection = read('src/app/settings/sections/MembersSection.tsx');
    const voiceSection = read('src/app/settings/sections/VoiceSection.tsx');
    const trainingAssignmentsRoute = read('src/app/api/training/assignments/route.ts');

    // The kanji-only stand-in literals (研修/受講課程/割当) that avoided the
    // kana-based I18N-03 scanner are gone.
    for (const standIn of ['研修', '受講課程', '割当']) {
      expect(membersSection).not.toContain(standIn);
    }
    expect(membersSection).toContain("frontDeskText('settings_training_title', locale)");
    expect(membersSection).toContain("frontDeskText('settings_training_track', locale)");
    expect(membersSection).toContain("frontDeskText('settings_training_assign', locale)");
    expect(membersSection).toContain("frontDeskText('settings_training_lead', locale)");
    // Statuses reuse the same `training_status_*` keys `static/help.js`
    // renders, not a section-local label map.
    expect(membersSection).toContain('training_status_not_started');
    expect(membersSection).toContain('training_status_in_progress');
    expect(membersSection).toContain('training_status_complete');

    // The voice-runtime card (`#voice-runtime-settings`) no longer borrows
    // the unrelated `setup.agent_display_name` / `setup.media_description`
    // keys — `t('setup.media_description')` legitimately stays elsewhere in
    // this file, as the 写真・音声 pane's own subtitle, so the check is
    // scoped to the voice-runtime card's own block.
    expect(voiceSection).toContain("frontDeskText('settings_voice_runtime_title', locale)");
    expect(voiceSection).toContain("frontDeskText('settings_voice_runtime_lead', locale)");
    const runtimeCardStart = voiceSection.indexOf('id="voice-runtime-settings"');
    expect(runtimeCardStart).toBeGreaterThan(-1);
    const runtimeCard = voiceSection.slice(runtimeCardStart, runtimeCardStart + 400);
    expect(runtimeCard).not.toContain('setup.agent_display_name');
    expect(runtimeCard).not.toContain('setup.media_description');

    // The training-assignment route's error messages resolve through the
    // shared `front_desk` catalog, per request locale, instead of an
    // inline Japanese literal.
    expect(trainingAssignmentsRoute).toContain(
      "frontDeskText('training_assign_owner_only', locale)"
    );
    expect(trainingAssignmentsRoute).toContain(
      "frontDeskText('training_assign_invalid_input', locale)"
    );
    expect(trainingAssignmentsRoute).not.toContain('組織の所有者だけが割り当てを変更できます。');
    expect(trainingAssignmentsRoute).not.toContain('割り当ての入力を確認してください。');
  });

  it('FD-06: resolves the 管制塔 (chronos-mirror-v2) link server-side, guarded like every other read route', () => {
    const route = read('src/app/api/front-desk/links/route.ts');
    expect(route).toContain('resolveConciergeViewer');
    expect(route).toMatch(/resolved\.response/);
    expect(route).toContain('no-store');
    expect(route).toContain('loadSurfaceManifest');
    expect(route).toContain('chronos-mirror-v2');
  });
});

describe('FD-00c buildFrontDeskNavPayload (unit)', () => {
  it('returns 5 rail items with ja labels, relative concierge hrefs, and absolute presence-studio hrefs', async () => {
    vi.resetModules();
    vi.doMock('@agent/core/front-desk-nav', async () => {
      const actual = await vi.importActual<typeof import('@agent/core/front-desk-nav')>(
        '@agent/core/front-desk-nav'
      );
      return {
        ...actual,
        readFrontDeskSurfacePorts: () => ({ 'presence-studio': 4031, concierge: 4050 }),
      };
    });

    const { buildFrontDeskNavPayload } = await import('../src/lib/front-desk-nav');
    const payload = buildFrontDeskNavPayload({ locale: 'ja', role: 'owner' });

    expect(payload.ok).toBe(true);
    expect(payload.current_surface).toBe('concierge');
    expect(payload.items).toHaveLength(5);
    expect(payload.items.map((item) => item.id)).toEqual([
      'home',
      'ask',
      'decide',
      'progress',
      'settings',
    ]);

    const byId = Object.fromEntries(payload.items.map((item) => [item.id, item]));
    expect(byId.home.label).toBe('ホーム');
    expect(byId.decide.label).toBe('決める');

    // decide/settings are hosted on concierge itself: relative, not external.
    expect(byId.decide.external).toBe(false);
    expect(byId.decide.href).toBe('/');
    expect(byId.settings.external).toBe(false);
    expect(byId.settings.href).toBe('/settings');

    // home/ask/progress are hosted on presence-studio: absolute, same-tab.
    for (const id of ['home', 'ask', 'progress'] as const) {
      expect(byId[id].external).toBe(true);
      expect(byId[id].href).toBe(`http://127.0.0.1:4031${byId[id].id === 'home' ? '/' : `/${id}`}`);
    }

    vi.doUnmock('@agent/core/front-desk-nav');
  });
});
