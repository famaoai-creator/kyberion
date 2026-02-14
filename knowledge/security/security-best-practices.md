# Security Best Practices

Comprehensive security reference for application development, covering vulnerability awareness, secure coding patterns, and tooling.

---

## 1. OWASP Top 10 Overview

The OWASP Top 10 represents the most critical web application security risks. Engineers should understand each category and apply mitigations proactively.

- **A01: Broken Access Control** -- Users act outside their intended permissions. Enforce least privilege, deny by default, and validate server-side access on every request.
- **A02: Cryptographic Failures** -- Sensitive data exposure due to weak or missing encryption. Use TLS 1.2+ in transit, AES-256 at rest, and never roll custom crypto.
- **A03: Injection** -- Untrusted data sent to an interpreter as part of a command or query. Use parameterized queries, ORMs, and input validation.
- **A04: Insecure Design** -- Flaws in architecture and design that cannot be fixed by implementation alone. Apply threat modeling early and use secure design patterns.
- **A05: Security Misconfiguration** -- Default credentials, open cloud storage, verbose error messages. Harden configurations, disable unnecessary features, and automate configuration audits.
- **A06: Vulnerable and Outdated Components** -- Using libraries with known CVEs. Maintain a software bill of materials (SBOM) and automate dependency scanning.
- **A07: Identification and Authentication Failures** -- Weak passwords, missing MFA, broken session management. Enforce strong password policies, implement MFA, and use secure session tokens.
- **A08: Software and Data Integrity Failures** -- Code and infrastructure that does not protect against integrity violations. Verify signatures, use lock files, and secure CI/CD pipelines.
- **A09: Security Logging and Monitoring Failures** -- Insufficient logging makes breaches undetectable. Log authentication events, access control failures, and server-side validation failures.
- **A10: Server-Side Request Forgery (SSRF)** -- Application fetches a remote resource without validating the user-supplied URL. Sanitize URLs, use allowlists, and disable unused URL schemes.

---

## 2. Secure Coding Patterns for Node.js / JavaScript

### Input Validation

```javascript
// Use a schema validation library (e.g., zod, joi) for all external input
const { z } = require('zod');

const userSchema = z.object({
  email: z.string().email(),
  age: z.number().int().min(0).max(150),
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z\s'-]+$/),
});

function validateInput(data) {
  return userSchema.safeParse(data);
}
```

### Parameterized Queries

```javascript
// NEVER concatenate user input into SQL strings
// BAD:  db.query(`SELECT * FROM users WHERE id = ${userId}`)
// GOOD:
const result = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
```

### Secure Headers

```javascript
const helmet = require('helmet');
app.use(helmet()); // Sets Content-Security-Policy, X-Frame-Options, etc.
```

### Rate Limiting

```javascript
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per window
  standardHeaders: true,
});
app.use('/api/', limiter);
```

### Secrets Management

- Never store secrets in source code or environment files committed to version control.
- Use secret managers (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager).
- Rotate secrets regularly and audit access logs.

---

## 3. Common Vulnerability Patterns to Detect

### Code Review Red Flags

- **`eval()` or `Function()` with dynamic input** -- Code injection vector.
- **`dangerouslySetInnerHTML`** -- XSS risk in React applications.
- **`child_process.exec()` with unsanitized input** -- Command injection.
- **String concatenation in SQL queries** -- SQL injection.
- **Hardcoded credentials or API keys** -- Secret leakage.
- **Missing CSRF tokens on state-changing endpoints** -- Cross-site request forgery.
- **Permissive CORS (`Access-Control-Allow-Origin: *`)** -- Unauthorized cross-origin access.
- **Disabled TLS certificate verification** -- Man-in-the-middle attacks.
- **Logging sensitive data (passwords, tokens, PII)** -- Information disclosure.

### Dependency Vulnerabilities

- Outdated packages with known CVEs.
- Typosquatting packages (e.g., `lodash` vs `1odash`).
- Packages with excessive permissions or install scripts.

---

## 4. Security Scanning Tools and Use Cases

| Tool                       | Use Case                                              | Integration Point                        |
| -------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| **Snyk**                   | Dependency vulnerability scanning, container scanning | CI pipeline, IDE plugin                  |
| **SonarQube**              | Static application security testing (SAST)            | CI pipeline, PR checks                   |
| **OWASP ZAP**              | Dynamic application security testing (DAST)           | Staging environment scans                |
| **Trivy**                  | Container image and filesystem vulnerability scanning | CI pipeline, pre-deploy                  |
| **Semgrep**                | Custom static analysis rules, pattern matching        | CI pipeline, pre-commit                  |
| **Gitleaks / TruffleHog**  | Secret detection in git history                       | Pre-commit hooks, CI                     |
| **npm audit / yarn audit** | Node.js dependency vulnerability checks               | CI pipeline, local dev                   |
| **Checkov**                | Infrastructure-as-code (IaC) security scanning        | CI pipeline for Terraform/CloudFormation |

### Recommended Pipeline Integration

```yaml
# Example: GitHub Actions security scanning step
- name: Run security scans
  run: |
    npm audit --audit-level=high
    npx semgrep --config=auto .
    trivy fs --severity HIGH,CRITICAL .
```

---

## 5. Input Validation and Sanitization Guidelines

### Validation Principles

- **Validate on the server side** -- Client-side validation is for UX only; never trust it for security.
- **Use allowlists over denylists** -- Define what is permitted rather than what is blocked.
- **Validate data type, length, range, and format** -- Apply all relevant constraints.
- **Reject invalid input early** -- Fail fast and return clear (but non-leaking) error messages.

### Sanitization Strategies

- **HTML output**: Use context-aware encoding (HTML entity encoding for HTML contexts, JavaScript encoding for script contexts).
- **SQL**: Use parameterized queries exclusively; never sanitize and concatenate.
- **File uploads**: Validate MIME type and file extension, scan for malware, store outside the webroot, and generate new filenames.
- **URLs**: Parse and validate against an allowlist of schemes (`https://`) and domains.
- **Serialized data**: Avoid deserializing untrusted data; if unavoidable, use safe deserialization libraries with strict type checking.

### Content Security Policy (CSP)

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.example.com
```

- Avoid `'unsafe-eval'` and `'unsafe-inline'` for scripts.
- Use nonces or hashes for inline scripts when absolutely necessary.
- Report violations with `report-uri` or `report-to` directives.

---

## 6. Authentication and Session Security

- Enforce multi-factor authentication (MFA) for all privileged accounts.
- Use secure, HttpOnly, SameSite cookies for session tokens.
- Implement session expiration and idle timeout.
- Invalidate sessions on password change or privilege escalation.
- Hash passwords with bcrypt, scrypt, or Argon2 (never MD5 or SHA-1 alone).

---

## 7. Security Review Checklist

Before merging any feature branch, verify:

- [ ] All user inputs are validated and sanitized.
- [ ] No secrets or credentials are hardcoded.
- [ ] Authentication and authorization checks are enforced server-side.
- [ ] Security headers are configured (CSP, HSTS, X-Content-Type-Options).
- [ ] Dependencies have been scanned for known vulnerabilities.
- [ ] Error messages do not leak internal details (stack traces, SQL errors).
- [ ] Logging captures security-relevant events without recording sensitive data.
- [ ] Rate limiting is applied to authentication and API endpoints.
