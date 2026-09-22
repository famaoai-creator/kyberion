/* eslint-disable no-restricted-imports */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '../../..');

/**
 * WI-15: same "contract test" posture as concierge-contract.test.ts (no
 * React Testing Library in this package) — proves the section wires every
 * `front_desk` vocabulary key it needs, the settings page registers the
 * section, and every key referenced actually exists in the catalog with a
 * non-empty en/ja value (the "section renders keys" acceptance condition).
 */
describe('concierge recording-consent settings contract', () => {
  const sectionSource = fs.readFileSync(
    path.join(appDir, 'src/app/settings/sections/RecordingConsentSection.tsx'),
    'utf8'
  );
  const settingsView = fs.readFileSync(path.join(appDir, 'src/lib/settings-view.ts'), 'utf8');
  const page = fs.readFileSync(path.join(appDir, 'src/app/settings/page.tsx'), 'utf8');
  const vocabulary = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, 'knowledge/product/orchestration/user-facing-vocabulary.json'),
      'utf8'
    )
  ) as { domains: Record<string, Record<string, Record<string, string>>> };

  it('registers the recording section after notifications, before plugins', () => {
    expect(settingsView).toMatch(/'notifications',\s*\n\s*'recording',\s*\n\s*'plugins'/);
  });

  it('wires the section into the settings page render switch and nav label', () => {
    expect(page).toContain(
      "import { RecordingConsentSection } from './sections/RecordingConsentSection';"
    );
    expect(page).toContain("case 'recording':");
    expect(page).toContain('<RecordingConsentSection');
    expect(page).toContain("recording: 'settings_nav_recording'");
  });

  it('every front_desk:settings_recording_* key the section references exists with en+ja text', () => {
    const referenced = new Set(
      [...sectionSource.matchAll(/'(settings_recording_[a-z0-9_]+)'/g)].map((match) => match[1])
    );
    // The section must reference every action/label key the route contracts assume.
    expect([...referenced]).toEqual(
      expect.arrayContaining([
        'settings_recording_lead',
        'settings_recording_grant_title',
        'settings_recording_sources_label',
        'settings_recording_kinds_label',
        'settings_recording_purpose_label',
        'settings_recording_days_label',
        'settings_recording_days_hint',
        'settings_recording_grant_submit',
        'settings_recording_consents_title',
        'settings_recording_consents_empty',
        'settings_recording_consent_revoke',
        'settings_recording_pending_title',
        'settings_recording_pending_empty',
        'settings_recording_pending_confirm',
        'settings_recording_pending_discard',
        'settings_recording_pending_attach_label',
        'settings_recording_pending_attach_submit',
        'settings_recording_pending_attach_restricted',
      ])
    );
    const frontDesk = vocabulary.domains.front_desk;
    for (const key of referenced) {
      expect(frontDesk[key], `front_desk:${key} is missing from the catalog`).toBeDefined();
      expect(frontDesk[key].en?.length).toBeGreaterThan(0);
      expect(frontDesk[key].ja?.length).toBeGreaterThan(0);
    }
  });

  it('explains, in plain text, what is and is not recorded', () => {
    const lead = vocabulary.domains.front_desk.settings_recording_lead;
    expect(lead.en).toMatch(/never/i);
    expect(lead.ja).toContain('されません');
  });
});
