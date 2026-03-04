# Browser Automation Best Practices (Omni-Browser v2)

## 1. Interaction Strategy: The Hybrid Model
Do not rely solely on AI-generated indices for complex, dynamic UIs (e.g., calendars, SPAs). 
- **Use Indices** for discovery and general exploration.
- **Use Locators** (`role=button[name="..."]`) for critical paths learned via human demonstration (`codegen`).
- **Resilience Rule**: The engine should default to `.first()` when multiple elements match to prevent strict mode violations.

## 2. Protocol & Format
- **JSON-First**: Scenarios should be defined in JSON to avoid whitespace/indentation issues inherent in YAML parsers.
- **Reasoning First**: Every step should include a `reasoning` field. This allows the AI to self-correct and provides an audit trail for humans.

## 3. Handling Heavy Sites (ITmedia, News, etc.)
- **Navigation**: Use `waitUntil: 'load'` instead of `networkidle` for media-heavy sites to prevent unnecessary timeouts caused by background tracking scripts.
- **Buffer Wait**: Always add a brief `wait` (3000ms+) after search actions to allow dynamic content/AJAX to settle before taking a `snapshot`.

## 4. Extraction & Harvesting
- **URL Resolution**: Always resolve relative `href` paths against the base `url` provided in the snapshot root.
- **Sanitized Extraction**: Limit raw text extraction to the first 5000-20000 characters to prevent token overflow while maintaining context for LLM analysis.
