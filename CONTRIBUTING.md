# Contributing to Gemini Skills

## Getting Started

```bash
git clone <repo-url>
cd gemini-skills
npm install
npm run validate    # Verify all skills
npm run test:unit   # Run unit tests
```

## Creating a New Skill

Use the skill creation wizard:

```bash
npm run create-skill -- my-skill --description "What it does"
```

This creates the directory structure, SKILL.md, package.json, and starter script.

## Project Structure

```
gemini-skills/
  <skill-name>/
    SKILL.md              # Metadata and documentation
    package.json          # Dependencies
    scripts/
      main.cjs            # Entry point (uses runSkill wrapper)
  scripts/lib/
    skill-wrapper.cjs     # Standard I/O envelope
    validators.cjs        # Input validation helpers
    classifier.cjs        # Shared classification engine
    core.cjs              # Logging, file utils
    tier-guard.cjs        # Knowledge tier enforcement
    validate.cjs          # Schema validation
  schemas/                # JSON Schema definitions
  knowledge/              # 3-tier knowledge base
  tests/
    unit.test.cjs         # Unit tests
    smoke.test.cjs        # Syntax validation
    integration.test.cjs  # E2E pipeline tests
```

## Skill Development Guidelines

### Use the Skill Wrapper

All skills must use `runSkill()` or `runAsyncSkill()`:

```javascript
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');

runSkill('my-skill', () => {
  // your logic here
  return { result: 'data' };
});
```

### Use Input Validators

```javascript
const { validateFilePath, safeJsonParse } = require('../../scripts/lib/validators.cjs');

runSkill('my-skill', () => {
  const file = validateFilePath(argv.input);
  const data = safeJsonParse(rawString, 'config');
  return processData(data);
});
```

### Use Yargs for CLI Arguments

```javascript
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv)).option('input', {
  alias: 'i',
  type: 'string',
  demandOption: true,
}).argv;
```

### Knowledge Tier Rules

- **public**: Safe for any output
- **confidential**: Internal use only
- **personal**: User-specific, never share

Use `tier-guard.cjs` to validate data flow between tiers.

## Testing

### Adding Unit Tests

Add tests to `tests/unit.test.cjs`:

```javascript
test('my-skill does X', () => {
  const input = writeTemp('test.txt', 'content');
  const env = runAndParse('my-skill/scripts/main.cjs', `-i "${input}"`);
  assert(env.data.result === 'expected', 'Should return expected result');
});
```

### Running Tests

```bash
npm run test:unit           # Unit tests
npm test                    # Smoke tests
npm run test:integration    # E2E pipeline tests
npm run test:coverage       # Coverage report
```

## Code Quality

### Linting & Formatting

```bash
npx eslint .               # Check lint issues
npx prettier --check .     # Check formatting
npx prettier --write .     # Auto-format
```

### Quality Audit

```bash
npm run audit               # Skill quality scores
```

## Commit Convention

Use conventional commits:

```
feat: add new classifier skill
fix: handle empty input in format-detector
refactor: migrate core.cjs to TypeScript
test: add unit tests for security-scanner
docs: update CONTRIBUTING guide
```
