'use client';

import { KbChart } from '@agent/shared-ui';
import { ChronosKbI18n } from './chronos-kb-i18n';

/**
 * KyberionCharts — the chronos chart API, drawn by the shared `ui:*` chart
 * components (UI-07). Geometry, colors (`--kb-ui-viz-*` categorical slots),
 * legends, `aria-label`s and the visually hidden data table all come from
 * `@agent/shared-ui` (`layoutChart`), so chronos charts match every other
 * surface. The exported component names and props are unchanged; a datum's
 * `color` is accepted for compatibility but ignored — series colors are
 * assigned by slot, and identity never relies on color alone.
 */

export type ChartDatum = { label: string; value: number; color?: string };

function datums(data: ChartDatum[] | undefined): Array<{ label: string; value: number | null }> {
  return (Array.isArray(data) ? data : []).map((d) => ({
    label: String(d?.label ?? ''),
    value: Number.isFinite(Number(d?.value)) ? Number(d.value) : null,
  }));
}

// --- display:donut — distribution as a ring with a center total ---
export const KyberionDonut = ({
  title,
  data = [],
  centerLabel,
}: {
  title?: string;
  titleKey?: string;
  data?: ChartDatum[];
  centerLabel?: string;
  /** Accepted for compatibility; the shared donut sizes itself. */
  size?: number;
}) => (
  <ChronosKbI18n>
    <KbChart
      type="ui:donut"
      props={{ title, segments: datums(data), center_label: centerLabel, density: 'compact' }}
    />
  </ChronosKbI18n>
);
