import { loadSnapshot } from './data/loaders.js';
import { buildRail, deckCounts } from './model/attention.js';
import type { DeckSnapshot } from './model/types.js';
import { makeI18n, defaultLocale } from './i18n.js';
import { LANE_GLYPH, AGENT_GLYPH } from './ui/theme.js';
import { agentLabel, railItemLabel } from './ui/panes.js';
import type { VocabularyKey } from '@agent/core/t';
import type { SupportedLocale } from '@agent/core/locale';

/** Plain-text frame for non-TTY use (CI, pipes, IDE task runners). */
export function snapshotLines(
  snapshot: DeckSnapshot,
  locale: SupportedLocale = defaultLocale()
): string[] {
  const { tr } = makeI18n(locale);
  const counts = deckCounts(snapshot);
  const lines: string[] = [
    `KYBERION Mission Deck ▸ ${snapshot.scopeLabel}`,
    `${LANE_GLYPH.decide} ${tr('deck:count_decide', { count: counts.decide })}  ${LANE_GLYPH.running} ${tr('deck:count_running', { count: counts.running })}  ${LANE_GLYPH.review} ${tr('deck:count_review', { count: counts.review })}`,
  ];
  if (snapshot.nextAction) lines.push(`→ ${snapshot.nextAction.title}`);
  for (const group of buildRail(snapshot)) {
    lines.push(
      '',
      `${LANE_GLYPH[group.lane]} ${tr(`deck:lane_${group.lane}` as VocabularyKey)} (${group.items.length})`
    );
    for (const item of group.items) lines.push(`  ${railItemLabel(item)}`);
  }
  lines.push('', tr('deck:agents_title'));
  if (!snapshot.agentsAvailable) {
    lines.push(
      `  ${tr('deck:agents_unavailable')}${snapshot.agentsUnavailableReason ? ` — ${snapshot.agentsUnavailableReason}` : ''}`
    );
  } else if (snapshot.agents.length === 0) {
    lines.push(`  ${tr('deck:agents_none')}`);
  } else {
    for (const agent of snapshot.agents) {
      lines.push(
        `  ${AGENT_GLYPH[agent.state]} ${agentLabel(agent)}${agent.missionId ? ` ↳ ${agent.missionId}` : ''}`
      );
      const last = agent.tail[agent.tail.length - 1];
      if (last) lines.push(`      ${last}`);
    }
  }
  const failed = snapshot.health.filter((h) => !h.ok && h.source !== 'agents');
  if (failed.length) {
    lines.push('', tr('deck:snapshot_degraded'));
    for (const h of failed) lines.push(`  ${h.source}: ${h.detail ?? ''}`);
  }
  return lines;
}

export function renderSnapshotLines(locale?: SupportedLocale): string[] {
  const resolved = locale ?? defaultLocale();
  return snapshotLines(loadSnapshot({ locale: resolved }), resolved);
}
