export const VULNERABLE_CRYPTO = [
  { 
    pattern: /\b(RSA-1024|RSA-2048|SHA-1|MD5|3DES)\b/gi, 
    algorithm: 'Legacy/Weak',
    threat: 'Shor\'s Algorithm / Collision attacks',
    recommendation: 'Immediate upgrade to NIST PQC standards.'
  },
  { 
    pattern: /\b(ECC|Elliptic Curve|ECDSA|ECDH)\b/gi, 
    algorithm: 'ECC',
    threat: 'Highly vulnerable to Quantum Computing (QC)',
    recommendation: 'Plan migration to ML-DSA or SLH-DSA.'
  },
];

export const PQC_INDICATORS = [
  { name: 'ML-KEM', alias: 'Kyber', status: 'NIST Standardized (FIPS 203)' },
  { name: 'ML-DSA', alias: 'Dilithium', status: 'NIST Standardized (FIPS 204)' },
  { name: 'SLH-DSA', alias: 'Sphincs+', status: 'NIST Standardized (FIPS 205)' }
];

export function scanCryptoContent(content: string, fileName: string): any[] {
  const findings: any[] = [];
  
  // 1. Scan for vulnerabilities
  for (const vuln of VULNERABLE_CRYPTO) {
    const matches = content.match(vuln.pattern);
    if (matches) {
      findings.push({
        file: fileName,
        detected: vuln.algorithm,
        threat: vuln.threat,
        recommendation: vuln.recommendation,
        occurrences: [...new Set(matches)].length,
      });
    }
  }

  // 2. Scan for PQC Readiness (Crypto-agility)
  for (const pqc of PQC_INDICATORS) {
    if (content.toUpperCase().includes(pqc.name) || content.toUpperCase().includes(pqc.alias.toUpperCase())) {
      findings.push({
        file: fileName,
        detected: pqc.name,
        pqc_readiness: 'HIGH',
        status: pqc.status
      });
    }
  }

  return findings;
}
