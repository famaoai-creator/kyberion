# Conceptual Frameworks Reference

This document consolidates 26 conceptual frameworks that inform the Gemini Skills ecosystem. These are guidelines, thinking models, and governance principles -- not executable skills.

---

## 1. Vision & Strategy

### north-star-guardian

**Description:** Ensures the project remains aligned with its core mission. Audits features and technical decisions against the project's "North Star" goals to prevent scope creep and misalignment.

**Capabilities:**

- **Mission Alignment Audit**: Evaluates new feature requests and architectural proposals against the project's defined mission statement. Identifies "Distraction Features" that do not contribute to long-term strategic goals.
- **Strategic Reminders**: Periodically reminds the team of the "North Star" metrics and goals during `mission-control` or `strategic-roadmap-planner` executions.

### visionary-ethos-keeper

**Description:** Preserves the company's mission and "soul." Audits high-level decisions against the core purpose and values defined by the CEO.

**Capabilities:**

- **Purpose Alignment**: Audits major decisions (M&A, new product lines, major technical pivots) against the `corporate_purpose.md`. Acts as a "Devil's Advocate" to ensure profit-seeking doesn't compromise core values.
- **Cultural Pulse**: Connects with `engineering-culture-analyst` to ensure that the actual culture reflects the CEO's vision.

### scenario-multiverse-orchestrator

**Description:** Simulates multiple business and technical scenarios simultaneously. Provides comparative reports on Growth, Stability, and Hybrid paths for executive decision-making.

**Capabilities:**

- **Parallel Path Simulation**: Simultaneously executes models for different strategic stances (e.g., Aggressive vs. Conservative). Correlates technical velocity, financial runway, and talent acquisition risks across all paths.
- **Comparative Reporting**: Generates side-by-side comparison tables and impact forecasts.

---

## 2. AI Governance & Safety

### kill-switch-guardian

**Description:** The ultimate safety valve. Provides an encrypted, human-only protocol to immediately freeze and roll back all autonomous AI actions in case of unexpected behavior.

**Capabilities:**

- **Emergency Freeze**: Immediately halts all running AI skills and background processes initiated by `mission-control`. Revokes temporary write permissions for autonomous agents.
- **Verified Rollback**: Provides an authenticated path for a human lead to revert all AI-generated changes to the last known "Human-Certified" safe state.

### human-in-the-loop-orchestrator

**Description:** Integrates human judgment into AI workflows. Automatically pauses autonomous processes for human review when uncertainty is high or ethical stakes are significant.

**Capabilities:**

- **Uncertainty Triage**: Monitors the confidence scores of other skills. Injects a mandatory "Human Approval" step if confidence falls below a set threshold.
- **Decision Learning**: Records human corrections or approvals to fine-tune future AI decision-making logic.

### hive-mind-sync

**Description:** Synchronizes anonymized learning patterns across a federated network of Gemini agents. Enables collective intelligence evolution.

**Capabilities:**

- **Pattern Export**: Extracts "Success Patterns" from local logs, anonymizes sensitive data, and pushes to a central repository.
- **Wisdom Import**: Pulls new patterns and updates local configurations with community-verified best practices.

### ecosystem-federator

**Description:** Negotiates and synchronizes with external AI agents and repositories. Handles cross-project dependency alignment and specification negotiations.

**Capabilities:**

- **Cross-Project Negotiation**: Communicates with other agents to align on breaking changes in shared APIs or libraries.
- **Specification Alignment**: Ensures local specifications match external standards or partner requirements through automated dialogue.

---

## 3. Culture & People

### creator-mentor

**Description:** Personalized coaching for the developer. Analyzes historical interactions and code changes to provide customized technical advice.

**Capabilities:**

- **Pattern Reflection**: Identifies your "Signature Moves" (favorite design patterns) and "Blind Spots" (common recurring bugs).
- **Strategic Coaching**: Provides high-level architectural advice matching personal growth goals.

### engineering-culture-analyst

**Description:** Audits team dynamics and communication patterns. Identifies risks of burnout, knowledge silos, or toxic review behaviors.

**Capabilities:**

- **Communication Audit**: Analyzes the tone and constructiveness of code review comments (anonymized). Identifies "Knowledge Silos."
- **Burnout Risk Detection**: Detects patterns of excessive late-night commits or long streaks without breaks.

### human-capital-portfolio-analyst

**Description:** Maps current team skills against the future roadmap to optimize organization design. Proposes hiring, reskilling, and team restructuring strategies.

**Capabilities:**

- **Skill Gap Visualization**: Correlates roadmap with current team profiles. Highlights "Bottleneck Teams" where talent shortages may delay the vision.
- **Organizational Evolution**: Suggests reskilling plans or identifies specific roles for hiring.

### community-health-guardian

**Description:** Monitors the health of developer communities and open-source projects. Analyzes response times, contributor retention, and document clarity.

**Capabilities:**

- **Engagement Metrics**: Analyzes PR/Issue response times and "Stale" labels. Tracks contributor retention.
- **Clarity Audit**: Evaluates "Newcomer Friendliness" of READMEs and contribution guides.

### public-relations-shield

**Description:** Manages crisis communication and brand defense. Translates technical incidents into empathetic, trust-building public statements.

**Capabilities:**

- **Crisis Messaging**: Translates technical failure timelines into human-centered press releases.
- **Stakeholder Narrative**: Drafts messaging for specific groups (Users, Investors, Partners).

---

## 4. Innovation & Future-Thinking

### future-evolution-oracle

**Description:** Predicts technology trends 10+ years ahead to extend code lifespan. Helps engineers design architectures that remain relevant in the 2030s and beyond.

**Capabilities:**

- **Trend Acceleration Analysis**: Analyzes the trajectory of tech stacks. Identifies "Dead End" technologies likely to become legacy within 5 years.
- **Backcasting Design**: Starts from a 2035 technological vision and works backward to suggest architectural choices today.

### innovation-scout

**Description:** Proactively researches the latest tech trends and academic papers to suggest optimizations. Identifies new libraries or algorithms.

**Capabilities:**

- **External Research**: Scans GitHub Trends, arXiv papers, and tech blogs for innovations relevant to your tech stack.
- **Integration Proposal**: Proposes specific refactoring or new library adoption with a clear "Pros/Cons" analysis.

### universal-polymath-engine

**Description:** Applies knowledge from biology, physics, economics, and other fields to engineering. Inspires cross-disciplinary innovation.

**Capabilities:**

- **Cross-Disciplinary Analogy**: Applies concepts like Natural Selection, Thermodynamics, or Game Theory to engineering problems.
- **Biomimetic & Physical Modeling**: Proposes architectural patterns inspired by biological immune systems or physical structures.

### social-impact-forecaster

**Description:** Simulates long-term societal and behavioral impacts of software. Identifies risks related to digital addiction, inequality, or isolation.

**Capabilities:**

- **Behavioral Simulation**: Predicts how features might change user habits. Identifies potential negative feedback loops.
- **Equality & Justice Audit**: Evaluates if algorithms or UI choices unintentionally favor one demographic over another.

---

## 5. Quality & Craftsmanship

### aesthetic-elegance-auditor

**Description:** Audits code for mathematical and artistic "Elegance." Evaluates symmetry, conciseness, and structural beauty.

**Capabilities:**

- **Elegance Scoring**: Evaluates code based on principles of symmetry, minimal entropy, and expressive power.
- **Masterpiece Refactoring**: Suggests transformations that elevate code to its most elegant form.

### cognitive-load-auditor

**Description:** Analyzes code and UI complexity from a cognitive science perspective. Identifies areas that exceed human information processing limits.

**Capabilities:**

- **Developer Experience (DX) Audit**: Estimates Cyclomatic Complexity and nesting depth. Identifies "Spaghetti Logic."
- **User Cognitive Load**: Analyzes UI density and decision points. Flags "Choice Overload."

### shadow-counselor

**Description:** A background thinking process that re-evaluates past decisions during idle time. Simulates "What If" scenarios to find hidden risks.

**Capabilities:**

- **Retroactive Simulation**: Takes the day's major decisions and runs counter-factual simulations.
- **The Morning Briefing**: Generates risk reports with mitigation plans.

---

## 6. Risk & Resilience

### global-risk-intelligence-sentinel

**Description:** Monitors external physical and geopolitical risks that could impact the project. Proposes mitigation plans for external dependencies.

**Capabilities:**

- **External Threat Monitoring**: Analyzes news and status feeds for cloud provider issues, geopolitical conflicts, or regulatory changes.
- **Impact Assessment**: Maps real-world risks to specific project components and proposes immediate mitigation steps.

### sovereignty-maestro

**Description:** Monitors data residency and sovereignty compliance. Ensures user data flows comply with local laws (GDPR, CCPA).

**Capabilities:**

- **Residency Audit**: Maps data flows and storage locations against user origins and regional laws.
- **Sovereignty Planning**: Recommends multi-region configurations to satisfy local data sovereignty requirements.

---

## 7. Knowledge & Preservation

### deep-archive-librarian

**Description:** Manages the lifecycle of long-term knowledge. Archives stale logs and documents while maintaining a search index.

**Capabilities:**

- **Auto-Archiving**: Scans for items older than 6 months and moves them to compressed archive.
- **Metadata Indexing**: Extracts key "Lessons Learned" before archiving to preserve wisdom.

### intent-archivist

**Description:** Captures and indexes the "Rationale" behind technical decisions. Preserves the "Why" for future teams.

**Capabilities:**

- **Rationale Extraction**: Analyzes PR threads and design documents to identify why specific paths were chosen.
- **Decision Indexing**: Creates a searchable "Decision Log" linking code modules to original discussions.

### eternal-self-preservation-guardian

**Description:** Ensures the project's "soul" survives for centuries. Builds distributed archives and human-readable recovery guides for 100-year longevity.

**Capabilities:**

- **Ultra-Long-Term Archiving**: Generates "Soul Backups" designed to be interpreted by future AIs or humans with minimal context.
- **Time-Capsule Documentation**: Writes "Letters to the Future" that explain the project's purpose beyond current technical jargon.

### empathy-engine

**Description:** Analyzes the emotional pulse of the user community. Correlates user feedback to prioritize development tasks based on "Emotional Impact."

**Capabilities:**

- **Emotional Pulse Analysis**: Analyzes support tickets, reviews, and social media to identify "Pain Points" and "Joy Points."
- **Empathy-Driven Prioritization**: Recommends task priority based on "Relieving Frustration" or "Delivering Delight."

### persona-matrix-switcher

**Description:** Dynamically switches the agent's persona and perspective. Simulates multi-stakeholder debates.

**Capabilities:**

- **Dynamic Roleplay**: Adopts the tone, bias, and priorities of a specific persona defined in `knowledge/personalities/matrix.md`.
- **Debate Simulation**: Simulates conversations between conflicting personas and synthesizes "Dialectical Conclusions."
