import type { CloudflareOsSurfaceSnapshot } from '@agent/core/cloudflare-os-surface';
import type { CSSProperties } from 'react';

export default function OsControlPlanePanel({
  snapshot,
  tenantScope,
  guardedSurfaceUrl,
}: {
  snapshot: CloudflareOsSurfaceSnapshot;
  tenantScope?: string;
  guardedSurfaceUrl?: string;
}) {
  return (
    <section style={panelStyle} aria-labelledby="os-control-plane-heading">
      <div style={headerStyle}>
        <div>
          <div style={eyebrowStyle}>Cloudflare OS projection</div>
          <h2 id="os-control-plane-heading" style={headingStyle}>
            Held actions &amp; observations
          </h2>
          <p style={descriptionStyle}>
            Tenant-scoped read-only projection. Decisions and apply remain in the guarded surface.
          </p>
          {!tenantScope ? (
            <p style={warningStyle}>
              Tenant scope is not configured. Only public observations are shown; held actions are
              hidden. Set <code>KYBERION_TENANT</code> before exposing MOS.
            </p>
          ) : null}
        </div>
        <span style={readOnlyBadge}>READ-ONLY</span>
      </div>

      <div style={columnsStyle}>
        <div>
          <h3 style={subheadingStyle}>Held actions ({snapshot.heldActions.length})</h3>
          {snapshot.heldActions.length ? (
            <div style={stackStyle}>
              {snapshot.heldActions.slice(0, 8).map((item) => (
                <article key={item.id} style={itemStyle}>
                  <div style={rowStyle}>
                    <strong style={truncateStyle}>{item.op}</strong>
                    <span style={statusStyle}>{item.status}</span>
                  </div>
                  <div style={metaStyle}>
                    {item.missionId} · {item.tenantSlug || 'public'} · {item.submittedBy}
                  </div>
                  <div style={mutedStyle}>
                    {item.irreversible ? 'irreversible' : 'reversible'} ·{' '}
                    {item.effectBinding || 'effect binding unavailable'}
                    {item.failureRecorded ? ' · apply failed' : ''}
                  </div>
                  <div style={metaStyle}>submitted {item.submittedAt}</div>
                </article>
              ))}
            </div>
          ) : (
            <p style={emptyStyle}>No held actions are visible to this operator.</p>
          )}
        </div>

        <div>
          <h3 style={subheadingStyle}>Observation audit ({snapshot.observations.length})</h3>
          {snapshot.observations.length ? (
            <div style={stackStyle}>
              {snapshot.observations.slice(0, 8).map((item) => (
                <article key={item.id} style={itemStyle}>
                  <div style={rowStyle}>
                    <strong style={truncateStyle}>{item.service}</strong>
                    <span style={mutedStyle}>{item.tier}</span>
                  </div>
                  <div style={metaStyle}>
                    {item.resourceRef} · {item.purpose}
                  </div>
                  <div style={mutedStyle}>{item.summary}</div>
                  <div style={metaStyle}>
                    {item.id} · observed {item.observedAt}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p style={emptyStyle}>No observations recorded yet.</p>
          )}
        </div>
      </div>
      {snapshot.heldActions.length ? (
        <div style={nextActionStyle}>
          <strong>Human action required.</strong>{' '}
          {guardedSurfaceUrl ? (
            <a href={guardedSurfaceUrl} style={linkStyle}>
              Open the guarded surface to decide or apply.
            </a>
          ) : (
            <span>
              Configure <code>KYBERION_OS_GUARDED_SURFACE_URL</code> for the decision surface.
            </span>
          )}
        </div>
      ) : null}
    </section>
  );
}

const panelStyle: CSSProperties = {
  marginTop: '30px',
  padding: '20px',
  border: '1px solid var(--kb-border)',
  borderRadius: '8px',
  background: 'var(--kb-panel-bg)',
};
const headerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '16px',
  alignItems: 'flex-start',
};
const eyebrowStyle: CSSProperties = {
  color: 'var(--kb-accent-text)',
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
};
const headingStyle: CSSProperties = {
  margin: '4px 0 0',
  color: 'var(--kb-text-primary)',
  fontSize: '20px',
};
const descriptionStyle: CSSProperties = {
  margin: '8px 0 0',
  color: 'var(--kb-text-secondary)',
  fontSize: '13px',
};
const warningStyle: CSSProperties = {
  margin: '10px 0 0',
  padding: '8px 10px',
  border: '1px solid var(--kb-warning)',
  borderRadius: '6px',
  color: 'var(--kb-warning)',
  fontSize: '12px',
  lineHeight: 1.5,
};
const readOnlyBadge: CSSProperties = {
  flexShrink: 0,
  padding: '4px 8px',
  border: '1px solid var(--kb-border)',
  borderRadius: '999px',
  color: 'var(--kb-text-secondary)',
  fontFamily: 'var(--kb-font-mono)',
  fontSize: '10px',
};
const columnsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: '20px',
  marginTop: '20px',
};
const subheadingStyle: CSSProperties = {
  margin: '0 0 8px',
  color: 'var(--kb-text-primary)',
  fontSize: '14px',
};
const stackStyle: CSSProperties = { display: 'grid', gap: '8px' };
const itemStyle: CSSProperties = {
  padding: '10px 12px',
  border: '1px solid var(--kb-border)',
  borderRadius: '6px',
  background: 'var(--kb-bg-main)',
};
const rowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '10px',
  alignItems: 'center',
};
const truncateStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--kb-text-primary)',
  fontSize: '12px',
};
const statusStyle: CSSProperties = {
  flexShrink: 0,
  color: 'var(--kb-accent-text)',
  fontFamily: 'var(--kb-font-mono)',
  fontSize: '10px',
  textTransform: 'uppercase',
};
const metaStyle: CSSProperties = {
  marginTop: '6px',
  color: 'var(--kb-text-secondary)',
  fontSize: '11px',
  lineHeight: 1.5,
  overflowWrap: 'anywhere',
};
const mutedStyle: CSSProperties = {
  marginTop: '4px',
  color: 'var(--kb-muted-text)',
  fontSize: '11px',
  lineHeight: 1.5,
  overflowWrap: 'anywhere',
};
const emptyStyle: CSSProperties = {
  margin: 0,
  padding: '12px',
  border: '1px dashed var(--kb-border)',
  borderRadius: '6px',
  color: 'var(--kb-text-secondary)',
  fontSize: '13px',
};
const nextActionStyle: CSSProperties = {
  marginTop: '16px',
  padding: '10px 12px',
  border: '1px solid var(--kb-warning)',
  borderRadius: '6px',
  color: 'var(--kb-text-primary)',
  fontSize: '12px',
  lineHeight: 1.5,
};
const linkStyle: CSSProperties = { color: 'var(--kb-accent-text)', fontWeight: 600 };
