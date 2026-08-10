// GENERATED FROM knowledge/product/governance/knowledge-sync-rules.json.
// Run pnpm generate:pii-rules after changing the governed source.
globalThis.__kyberionPiiScrub = (value) => {
  let text = String(value ?? '');
  const rules = [
    { id: "API_KEY", pattern: new RegExp("AIza[0-9A-Za-z-_]{35}", 'gu'), replacement: "[REDACTED:API_KEY]" },
    { id: "CREDIT_CARD", pattern: new RegExp("(?<![0-9A-Fa-f])(?:\\d[ -]?){12,18}\\d(?![0-9A-Fa-f-])", 'gu'), replacement: "[REDACTED:CREDIT_CARD]" },
    { id: "EMAIL_ADDRESS", pattern: new RegExp("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", 'gu'), replacement: "[REDACTED:EMAIL_ADDRESS]" },
    { id: "GENERIC_SECRET", pattern: new RegExp("secret[:=]\\s*['\"][0-9A-Za-z-_]{16,}['\"]", 'gu'), replacement: "[REDACTED:GENERIC_SECRET]" },
    { id: "JP_BANK_ACCOUNT", pattern: new RegExp("(?:口座番号|口座|支店|普通|当座)\\D{0,10}\\d{7}(?!\\d)", 'gu'), replacement: "[REDACTED:JP_BANK_ACCOUNT]" },
    { id: "JP_MY_NUMBER", pattern: new RegExp("(?<![0-9A-Fa-f])\\d{4}[- ]?\\d{4}[- ]?\\d{4}(?![0-9A-Fa-f])", 'gu'), replacement: "[REDACTED:JP_MY_NUMBER]" },
    { id: "JP_PHONE_NUMBER", pattern: new RegExp("(?<![\\d-])0\\d{1,4}-\\d{1,4}-\\d{4}(?![\\d-])", 'gu'), replacement: "[REDACTED:JP_PHONE_NUMBER]" },
    { id: "JP_POSTAL_ADDRESS", pattern: new RegExp("〒\\s*\\d{3}-?\\d{4}", 'gu'), replacement: "[REDACTED:JP_POSTAL_ADDRESS]" },
    { id: "OAUTH_SECRET", pattern: new RegExp("[0-9A-Za-z-_]{24,32}\\.apps\\.googleusercontent\\.com", 'gu'), replacement: "[REDACTED:OAUTH_SECRET]" },
    { id: "PRIVATE_KEY", pattern: new RegExp("-----BEGIN PRIVATE KEY-----", 'gu'), replacement: "[REDACTED:PRIVATE_KEY]" },
  ];
  for (const rule of rules) {
    try { text = text.replace(rule.pattern, rule.replacement); } catch { return '[REDACTED:pii-rule-error]'; }
  }
  return text;
};
