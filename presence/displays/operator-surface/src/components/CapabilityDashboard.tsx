import React from 'react';

interface Dependency {
  id: string;
  status: 'available' | 'missing';
  provider: string;
}

interface Bundle {
  bundle_id: string;
  status: string;
  kind: string;
  summary: string;
  health: 'active' | 'degraded' | 'inactive';
  intents?: string[];
  required_actuators?: string[];
  dependencies?: Dependency[];
}

interface CapabilityDashboardProps {
  bundles: Bundle[];
  pins: Record<string, any>;
}

export default function CapabilityDashboard({ bundles, pins }: CapabilityDashboardProps) {
  return (
    <div style={{ marginTop: '40px', borderTop: '1px solid var(--kb-border, #2a2c33)', paddingTop: '30px' }}>
      <h2 style={{ color: 'var(--kb-text-primary)', marginBottom: '8px' }}>🤖 Capability & Extension Control Plane</h2>
      <p style={{ color: 'var(--kb-text-secondary)', marginTop: 0, fontSize: '14px' }}>
        Dynamic harness capability matrix and visual provider-pin management. Read-only.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '30px', marginTop: '20px' }}>

        {/* Capability Matrix Section */}
        <div style={sectionBox}>
          <h3 style={sectionTitle}>⚡ Capability Bundle Matrix</h3>
          <div style={gridContainer}>
            {bundles.map(bundle => (
              <div key={bundle.bundle_id} style={cardStyle(bundle.health)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={bundleTitle}>{bundle.bundle_id}</span>
                  <span style={healthBadge(bundle.health)}>{bundle.health.toUpperCase()}</span>
                </div>
                <p style={bundleSummary}>{bundle.summary}</p>
                <div style={{ marginTop: '12px' }}>
                  <strong style={metaLabel}>Intents:</strong>{' '}
                  <span style={metaValue}>{(bundle.intents || []).join(', ') || 'None'}</span>
                </div>
                {bundle.dependencies && bundle.dependencies.length > 0 && (
                  <div style={{ marginTop: '12px', borderTop: '1px solid var(--kb-border, #2a2c33)', paddingTop: '8px' }}>
                    <strong style={metaLabel}>Probe Dependencies:</strong>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
                      {bundle.dependencies.map(dep => (
                        <div key={dep.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                          <span style={{ color: 'var(--kb-text-secondary)' }}>{dep.id.replace('provider.runtime.', '')}</span>
                          {/* Semantic status colors (success/danger) are not brand tokens yet. */}
                          <span style={{ color: dep.status === 'available' ? '#9be3a8' : '#ff8fa3' }}>
                            {dep.status === 'available' ? '✓ OK' : '✗ Missing'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Visual Pin Manager Section */}
        <div style={sectionBox}>
          <h3 style={sectionTitle}>📌 Visual Provider Pin Manager</h3>
          {Object.keys(pins).length === 0 ? (
            <p style={{ color: 'var(--kb-text-secondary)', fontSize: '14px', fontStyle: 'italic' }}>
              No active provider decisions pinned to this workspace session.
            </p>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr style={{ background: 'var(--kb-panel-bg)', textAlign: 'left' }}>
                  <th style={thStyle}>Decision Key</th>
                  <th style={thStyle}>Pinned Provider</th>
                  <th style={thStyle}>Model ID</th>
                  <th style={thStyle}>Orchestration</th>
                  <th style={thStyle}>Pinned At</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(pins).map(([key, pin]: [string, any]) => (
                  <tr key={key} style={{ borderBottom: '1px solid var(--kb-border, #1a1c22)' }}>
                    <td style={tdStyle}><strong>{key}</strong></td>
                    <td style={tdStyle}><span style={providerBadge}>{pin.provider}</span></td>
                    <td style={tdStyle}><code>{pin.modelId}</code></td>
                    <td style={tdStyle}><code>{pin.orchestration}</code></td>
                    <td style={tdStyle}><span style={{ color: 'var(--kb-text-secondary)', fontSize: '12px' }}>{new Date(pin.pinnedAt).toLocaleString()}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

      </div>
    </div>
  );
}

// Styling Object definitions
const sectionBox: React.CSSProperties = {
  background: 'var(--kb-panel-bg)',
  border: '1px solid var(--kb-border, #21262d)',
  borderRadius: '8px',
  padding: '20px'
};

const sectionTitle: React.CSSProperties = {
  color: 'var(--kb-text-primary)',
  fontSize: '18px',
  fontWeight: 600,
  marginTop: 0,
  marginBottom: '16px'
};

const gridContainer: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: '16px'
};

const cardStyle = (health: 'active' | 'degraded' | 'inactive'): React.CSSProperties => {
  const borderColors = {
    active: 'var(--kb-warning)', // Was #308e49
    degraded: 'var(--kb-accent)', // Was #8e7a30
    inactive: 'var(--kb-secondary)' // Was #8e3030
  };
  return {
    background: 'var(--kb-bg-main)', // Was #161b22
    border: `1px solid ${borderColors[health]}`,
    borderRadius: '6px',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between'
  };
};

const bundleTitle: React.CSSProperties = {
  fontWeight: 600,
  color: 'var(--kb-text-primary)',
  fontSize: '15px'
};

const healthBadge = (health: 'active' | 'degraded' | 'inactive'): React.CSSProperties => {
  const colors = {
    active: { bg: 'var(--kb-bg-main)', text: 'var(--kb-warning)' },
    degraded: { bg: 'var(--kb-bg-main)', text: 'var(--kb-accent)' },
    inactive: { bg: 'var(--kb-bg-main)', text: 'var(--kb-secondary)' }
  };
  return {
    background: colors[health].bg,
    color: colors[health].text,
    fontSize: '10px',
    fontWeight: 'bold',
    padding: '2px 6px',
    borderRadius: '10px',
    fontFamily: 'var(--kb-font-mono, monospace)'
  };
};

const bundleSummary: React.CSSProperties = {
  fontSize: '13px',
  color: 'var(--kb-text-secondary)',
  marginTop: '8px',
  marginBottom: 0
};

const metaLabel: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--kb-text-secondary)'
};

const metaValue: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--kb-text-primary)',
  fontFamily: 'var(--kb-font-mono, monospace)'
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '13px',
  marginTop: '12px'
};

const thStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--kb-border, #21262d)',
  color: 'var(--kb-text-secondary)',
  fontWeight: 600
};

const tdStyle: React.CSSProperties = {
  padding: '10px 12px',
  verticalAlign: 'middle',
  color: 'var(--kb-text-primary)'
};

const providerBadge: React.CSSProperties = {
  background: 'var(--kb-accent)',
  color: 'var(--kb-bg-main)',
  padding: '2px 6px',
  borderRadius: '4px',
  fontSize: '11px',
  fontFamily: 'var(--kb-font-mono, monospace)'
};
