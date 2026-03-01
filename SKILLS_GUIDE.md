# Gemini Skills Ecosystem Guide

Total Skills: 142 (Implemented: 136)
Last updated: 2026/03/01

## 🛡️ The Core Mandates (Common Library First)

To maintain ecosystem integrity, all skills **MUST** adhere to these foundational rules:

### 1. Unified Core Dependencies
Never use raw Node.js modules for I/O or path resolution.
- **I/O Operations**: Prohibited to use `fs` directly. Use `@agent/core/secure-io` (`safeReadFile`, `safeWriteFile`).
- **Path Resolution**: Always use `@agent/core/path-resolver` to ensure portability.
- **Logging**: Use `@agent/core/core` (`logger`) for consistent output.

### 2. Standardized Connection Hierarchy
All credentials and API keys MUST be stored in:
`knowledge/personal/connections/{provider}/{filename}.json`

### 3. Execution Model
Prefer `runSkillAsync` for any skill involving network or file operations.

---

## 📂 AUDIT

> Security, quality, and compliance scanning based on IPA/FISC standards.

| Skill                         | Description                                                                                          | Score | Avg Time | Usage                                          |
| :---------------------------- | :--------------------------------------------------------------------------------------------------- | :---- | :------- | :--------------------------------------------- |
| **ai-ethics-auditor**         | Audits AI systems for bias, fairness, and privacy. Analyzes prompts and datasets to ensure ethica... | N/A   | -        | `npm run cli -- run ai-ethics-auditor`         |
... (rest of table)
