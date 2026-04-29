function normalizeText(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

export function summarizeRequestText(request: string): string {
  const normalized = request.trim().replace(/\s+/g, ' ');
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

export function inferOptionalRoleHints(request: string): string[] {
  const text = normalizeText(request);
  const hints = new Set<string>();
  if (/(ux|ui|design|experience|デザイン|画面|体験)/u.test(text)) hints.add('experience_designer');
  if (/(strategy|roadmap|go[-\s]?to[-\s]?market|product|企画|戦略)/u.test(text)) hints.add('product_strategist');
  if (/(release|deploy|rollback|runtime|runbook|運用|監視|本番)/u.test(text)) hints.add('operator');
  if (/(slack|chronos|announcement|user update|連絡|通知|報告)/u.test(text)) hints.add('surface_liaison');
  return Array.from(hints);
}

export function inferMissingInputs(request: string, artifactPaths: string[] | undefined): string[] {
  const text = normalizeText(request);
  const artifacts = (artifactPaths || []).map((entry) => entry.toLowerCase());
  const missing: string[] = [];

  if (!text) missing.push('request_text');
  if (/(same as|前と同じ|それと同じ|同様に|as before)/u.test(text)) {
    missing.push('reference_context');
  }
  if (/(my voice|自分の声|私の声|voice clone)/u.test(text)) {
    const hasVoiceProfile = artifacts.some((entry) => entry.includes('voice-profile') || entry.includes('voice_profile'));
    if (!hasVoiceProfile) missing.push('voice_profile_id');
  }
  if (/(brand|design system|デザインシステム|ブランド)/u.test(text)) {
    const hasDesignInput = artifacts.some((entry) =>
      entry.includes('design-system') || entry.includes('design_system') || entry.includes('brand-guideline'),
    );
    if (!hasDesignInput) missing.push('design_system_reference');
  }

  return missing;
}
