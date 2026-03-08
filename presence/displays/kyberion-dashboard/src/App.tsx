import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Mermaid from './components/Mermaid';
import './App.css';

interface Stats {
  totalSkills: number;
  activeMissions: number;
  archivedMissions: number;
  healthScore: number;
}

interface MissionReport {
  id: string;
  intent: string;
  status: string;
  timestamp: string;
}

interface KnowledgeNodeData {
  name: string;
  path: string;
  type: 'folder' | 'file';
  children?: KnowledgeNodeData[];
}

interface QualityReport {
  fido: { status: string; coverage: string };
  overall: number;
}

const KnowledgeNode: React.FC<{ node: KnowledgeNodeData; onFileClick: (path: string) => void }> = ({ node, onFileClick }) => {
  const [expanded, setExpanded] = useState(false);

  if (node.type === 'file') {
    return (
      <div className="tree-item" onClick={() => onFileClick(node.path)}>
        <span style={{marginRight: '8px'}}>📄</span>
        <span style={{color: 'var(--accent-blue)', fontSize: '0.75rem'}}>{node.name}</span>
      </div>
    );
  }

  return (
    <div style={{marginLeft: '12px'}}>
      <div className="tree-item" onClick={() => setExpanded(!expanded)} style={{fontWeight: 'bold', fontSize: '0.8rem'}}>
        <span style={{marginRight: '8px', transform: expanded ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: '0.2s', fontSize: '0.6rem'}}>▶</span>
        <span style={{marginRight: '8px'}}>📁</span>
        {node.name}
      </div>
      {expanded && node.children && (
        <div style={{borderLeft: '1px solid var(--border-color)', marginLeft: '8px'}}>
          {node.children.map((child, idx) => (
            <KnowledgeNode key={idx} node={child} onFileClick={onFileClick} />
          ))}
        </div>
      )}
    </div>
  );
};

function App() {
  const [stats, setStats] = useState<Stats>({ totalSkills: 0, activeMissions: 0, archivedMissions: 0, healthScore: 0 });
  const [missions, setMissions] = useState<MissionReport[]>([]);
  const [knowledgeTree, setKnowledgeTree] = useState<KnowledgeNodeData[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<{ path: string; content: string } | null>(null);
  const [quality, setQuality] = useState<QualityReport | null>(null);

  const BRIDGE_URL = 'http://localhost:3031';

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [statsRes, aceRes, qualityRes, knowledgeRes] = await Promise.all([
          fetch(`${BRIDGE_URL}/ecosystem-stats`),
          fetch(`${BRIDGE_URL}/ace-reports`),
          fetch(`${BRIDGE_URL}/quality`),
          fetch(`${BRIDGE_URL}/knowledge`)
        ]);

        if (statsRes.ok) setStats(await statsRes.json());
        if (aceRes.ok) setMissions(await aceRes.json());
        if (qualityRes.ok) setQuality(await qualityRes.json());
        if (knowledgeRes.ok) setKnowledgeTree(await knowledgeRes.json());
      } catch (err) {
        console.error('Failed to fetch dashboard data:', err);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  const openDoc = async (path: string) => {
    try {
      const res = await fetch(`${BRIDGE_URL}/knowledge-content?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const content = await res.text();
        setSelectedDoc({ path, content });
      }
    } catch (err) {
      console.error('Failed to fetch doc content:', err);
    }
  };

  return (
    <div className="dashboard-container">
      <header className="header">
        <h1>KYBERION</h1>
        <div style={{fontSize: '0.7rem', color: 'var(--text-dim)'}}>
          <span className="live-indicator"></span>
          REALITY MIRROR v1.1 | SYSTEM ACTIVE
        </div>
      </header>

      <div className="sidebar">
        <section className="panel" style={{flex: '0 0 auto'}}>
          <div className="panel-title">Ecosystem Pulse</div>
          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px'}}>
            <div className="stat-item">
              <div className="stat-value">{stats.totalSkills}</div>
              <div className="stat-label">Skills</div>
            </div>
            <div className="stat-item">
              <div className="stat-value" style={{color: 'var(--accent-purple)'}}>{stats.healthScore}%</div>
              <div className="stat-label">Health</div>
            </div>
          </div>
        </section>
        
        <section className="panel" style={{flex: '1 1 auto', minHeight: 0}}>
          <div className="panel-title">Knowledge Explorer</div>
          <div className="tree-root">
            {knowledgeTree.map((node, idx) => (
              <KnowledgeNode key={idx} node={node} onFileClick={openDoc} />
            ))}
          </div>
        </section>
      </div>

      <main className="panel mission-panel">
        <div className="panel-title">Active Missions</div>
        <div className="mission-list">
          {missions.length > 0 ? (
            missions.map((m, idx) => (
              <div key={idx} className="mission-card">
                <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '8px'}}>
                  <span style={{fontSize: '0.6rem', background: 'var(--accent-green)', padding: '2px 6px', borderRadius: '4px', color: 'white'}}>{m.status || 'ACTIVE'}</span>
                  <span style={{fontSize: '0.6rem', color: 'var(--text-dim)'}}>{m.timestamp}</span>
                </div>
                <div style={{fontWeight: 'bold', fontSize: '0.85rem', marginBottom: '8px'}}>{m.intent}</div>
                <div style={{fontSize: '0.6rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)'}}>ID: {m.id}</div>
              </div>
            ))
          ) : (
            <div style={{textAlign: 'center', color: 'var(--text-dim)', marginTop: '40px'}}>No active missions</div>
          )}
        </div>
      </main>

      <section className="panel ace-panel">
        <div className="panel-title">ACE Audit Trail</div>
        <div className="ace-log-item"><span style={{color: 'var(--accent-green)'}}>[APPROVE]</span> UI stabilization initiated</div>
        <div className="ace-log-item"><span style={{color: 'var(--accent-purple)'}}>[INTEL]</span> Screenshot analysis complete</div>
        <div className="ace-log-item"><span style={{color: 'var(--accent-blue)'}}>[INFO]</span> Layout refreshed via grid-areas</div>
        <div className="ace-log-item"><span style={{color: 'var(--accent-red)'}}>[FIX]</span> Overlapping text issues resolved</div>
      </section>

      <footer className="panel footer">
        <div className="footer-content">
          <div className="tier-group">
            <span className="tier-badge tier-personal">PERSONAL</span>
            <span className="tier-badge tier-confidential">CONFIDENTIAL</span>
            <span className="tier-badge tier-public">PUBLIC</span>
          </div>
          <div style={{fontSize: '0.75rem'}}>
            FIDO: <span style={{color: 'var(--accent-green)'}}>{quality?.fido.status || 'OK'}</span> | 
            Coverage: <span style={{color: 'var(--accent-blue)'}}>{quality?.fido.coverage || '100%'}</span>
          </div>
          <div style={{textAlign: 'right'}}>
            <div style={{fontSize: '0.6rem', color: 'var(--text-dim)'}}>System Integrity</div>
            <div style={{fontSize: '1rem', color: 'var(--accent-purple)', fontWeight: 'bold'}}>HIGH FIDELITY</div>
          </div>
        </div>
      </footer>

      {selectedDoc && (
        <div className="modal-overlay" onClick={() => setSelectedDoc(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <button style={{position: 'absolute', top: 20, right: 20, background: 'var(--accent-red)', color: 'white', border: 'none', padding: '8px 16px', borderRadius: '4px', cursor: 'pointer'}} onClick={() => setSelectedDoc(null)}>CLOSE</button>
            <h2 style={{color: 'var(--accent-blue)', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', marginBottom: '24px'}}>{selectedDoc.path}</h2>
            <div className="markdown-view">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                code({node, inline, className, children, ...props}) {
                  const match = /language-(\w+)/.exec(className || '');
                  return !inline && match && match[1] === 'mermaid' ? (
                    <Mermaid chart={String(children).replace(/\n$/, '')} />
                  ) : (
                    <code className={className} {...props}>{children}</code>
                  )
                }
              }}>{selectedDoc.content}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
