'use client';

import * as React from 'react';
import { decideWithPasskey } from '../../../lib/passkey-client';
import { frontDeskFetch as fetch } from '../../../lib/front-desk-fetch';
import { Button, SettingsGroup, Badge } from '@agent/shared-ui';

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

type PendingApproval = {
  request_id: string;
  status: string;
  channel: string;
  kind: string;
  expires_at?: string;
  presented_digest?: string;
};
type ApprovalRule = {
  id: string;
  intent_ids: string[];
  decision_types: string[];
  min_assurance: string;
};
type Member = {
  member_id: string;
  display_name: string;
  external_identities: { issuer: string; subject: string; email?: string }[];
};
type Overview = {
  pending_approvals: PendingApproval[];
  approval_rules: ApprovalRule[];
  members: Member[];
  current_identity: { issuer: string; subject: string; email?: string } | null;
  viewer_member_id: string | null;
};

function readOverview(value: unknown): Overview | null {
  if (!record(value) || value.ok !== true) return null;
  return {
    pending_approvals: Array.isArray(value.pending_approvals)
      ? (value.pending_approvals as PendingApproval[])
      : [],
    approval_rules: Array.isArray(value.approval_rules)
      ? (value.approval_rules as ApprovalRule[])
      : [],
    members: Array.isArray(value.members) ? (value.members as Member[]) : [],
    current_identity: record(value.current_identity)
      ? (value.current_identity as Overview['current_identity'])
      : null,
    viewer_member_id: typeof value.viewer_member_id === 'string' ? value.viewer_member_id : null,
  };
}

export function GovernanceSection() {
  const [data, setData] = React.useState<Overview | null>(null);
  const [linkMember, setLinkMember] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const res = await fetch('/api/governance-overview', { cache: 'no-store' });
    setData(readOverview(await res.json().catch(() => null)));
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return null;

  const ruleGroups = [
    {
      label: '権限・secret(A3 / dual-key)',
      rules: data.approval_rules.filter((r) => r.min_assurance === 'A3'),
    },
    {
      label: '業務上の決定',
      rules: data.approval_rules.filter(
        (r) => r.min_assurance !== 'A3' && r.decision_types.length > 0
      ),
    },
    {
      label: '操作・実行系',
      rules: data.approval_rules.filter(
        (r) => r.min_assurance !== 'A3' && r.decision_types.length === 0
      ),
    },
  ];

  return (
    <SettingsGroup title="Governance — approvals & identity">
      <div className="settings-row-block">
        <h4>承認待ち</h4>
        {data.pending_approvals.length === 0 && (
          <p className="kb-text kb-text--muted">承認待ちはありません。</p>
        )}
        {data.pending_approvals.map((request) => (
          <div key={request.request_id} className="settings-integration">
            <div className="kb-setting-row__text">
              <p className="kb-text">
                {request.kind || request.channel} <Badge label={request.status} tone="info" />
              </p>
              <p className="kb-text kb-text--muted">
                {request.request_id} · {request.channel}
                {request.expires_at ? ` · expires ${request.expires_at}` : ''}
              </p>
            </div>
            <Button
              label={busy ? '…' : 'Approve with passkey'}
              disabled={busy || request.status !== 'pending'}
              onClick={() =>
                void run(async () => {
                  await decideWithPasskey({
                    requestId: request.request_id,
                    decision: 'approved',
                    channel: request.channel,
                    storageChannel: request.channel,
                    presentedDigest: request.presented_digest,
                  });
                  setMessage(`approved ${request.request_id}`);
                  await load();
                })
              }
            />
          </div>
        ))}
      </div>

      <div className="settings-row-block">
        <h4>承認ルール</h4>
        {ruleGroups.map((group) => (
          <details key={group.label} open={group.label.startsWith('権限')}>
            <summary>
              {group.label} ({group.rules.length})
            </summary>
            <ul>
              {group.rules.map((rule) => (
                <li key={rule.id} className="kb-text">
                  <code>{rule.id}</code>
                  {rule.min_assurance !== 'A1' && (
                    <Badge label={rule.min_assurance} tone="warning" />
                  )}{' '}
                  {[...rule.intent_ids, ...rule.decision_types].slice(0, 4).join(', ')}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>

      <div className="settings-row-block">
        <h4>サインイン identity の紐付け</h4>
        {data.current_identity ? (
          <>
            <p className="kb-text">
              現在のログイン: <code>{data.current_identity.issuer}</code> / sub{' '}
              <code>{data.current_identity.subject}</code>
              {data.viewer_member_id ? (
                <Badge label={`linked → ${data.viewer_member_id}`} tone="success" />
              ) : (
                <Badge label="未紐付け" tone="warning" />
              )}
            </p>
            {!data.viewer_member_id && (
              <>
                <label>
                  紐付ける member
                  <select value={linkMember} onChange={(e) => setLinkMember(e.target.value)}>
                    <option value="">—</option>
                    {data.members.map((member) => (
                      <option key={member.member_id} value={member.member_id}>
                        {member.display_name} ({member.member_id})
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  label={busy ? '…' : 'このログインを member に紐付ける'}
                  disabled={busy || !linkMember}
                  onClick={() =>
                    void run(async () => {
                      const res = await fetch('/api/governance-overview', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'link_identity', member_id: linkMember }),
                      });
                      const value: unknown = await res.json().catch(() => null);
                      if (!res.ok || !record(value) || value.ok !== true)
                        throw new Error(
                          record(value) && typeof value.error === 'string'
                            ? value.error
                            : `http_${res.status}`
                        );
                      setMessage(`linked ${data.current_identity?.subject} → ${linkMember}`);
                      await load();
                    })
                  }
                />
              </>
            )}
          </>
        ) : (
          <p className="kb-text kb-text--muted">
            OIDC ログインではありません。`/login` から Dev IdP 等でサインインすると、ここで member
            に紐付けられます。
          </p>
        )}
        {data.members.some((m) => m.external_identities.length > 0) && (
          <ul>
            {data.members
              .filter((m) => m.external_identities.length > 0)
              .map((m) => (
                <li key={m.member_id} className="kb-text kb-text--muted">
                  {m.display_name}:{' '}
                  {m.external_identities.map((i) => `${i.issuer}/${i.subject}`).join(', ')}
                </li>
              ))}
          </ul>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p aria-live="polite">{message}</p>}
    </SettingsGroup>
  );
}
