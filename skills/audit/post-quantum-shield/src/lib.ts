export const VULNERABLE_CRYPTO = [
  { pattern: /\b(RSA|rsa)\b/g, algorithm: 'RSA' },
  { pattern: /\b(MD5|md5)\b/g, algorithm: 'MD5' },
];

export function scanCryptoContent(content: string, fileName: string): any[] {
  const findings: any[] = [];
  for (const vuln of VULNERABLE_CRYPTO) {
    const matches = content.match(vuln.pattern);
    if (matches) {
      findings.push({
        file: fileName,
        algorithm: vuln.algorithm,
        occurrences: matches.length,
      });
    }
  }
  return findings;
}
