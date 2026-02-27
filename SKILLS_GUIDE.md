# Gemini Skills Ecosystem Guide

Total Skills: 136 (Implemented: 136)
Last updated: 2026/02/27

This guide is a domain-driven catalog of the ecosystem. Skills are organized into Namespaces for better governance and accountability.

## 📂 AUDIT

> Security, quality, and compliance scanning based on IPA/FISC standards.

| Skill                         | Description                                                                                          | Score | Avg Time | Usage                                          |
| :---------------------------- | :--------------------------------------------------------------------------------------------------- | :---- | :------- | :--------------------------------------------- |
| **ai-ethics-auditor**         | Audits AI systems for bias, fairness, and privacy. Analyzes prompts and datasets to ensure ethica... | N/A   | -        | `npm run cli -- run ai-ethics-auditor`         |
| **bug-predictor**             | Predicts future bug hotspots by analyzing code complexity, churn, and historical defect patterns.... | N/A   | -        | `npm run cli -- run bug-predictor`             |
| **compliance-officer**        | Maps technical state to regulatory standards (SOC2, ISO27001, etc.). Generates real-time complian... | N/A   | -        | `npm run cli -- run compliance-officer`        |
| **license-auditor**           | Scans project dependencies for license compliance risks. Identifies restrictive licenses (GPL, AG... | N/A   | -        | `npm run cli -- run license-auditor`           |
| **monitoring-config-auditor** | Audits infrastructure code (Terraform, K8s) for monitoring compliance. Ensures alarms, thresholds... | N/A   | -        | `npm run cli -- run monitoring-config-auditor` |
| **post-quantum-shield**       | Audits codebases for quantum-vulnerable cryptography and plans migration to Post-Quantum Cryptogr... | N/A   | -        | `npm run cli -- run post-quantum-shield`       |
| **project-health-check**      | Audits the project for modern and Waterfall standards (SDLC, CI/CD, Tests, Quality Metrics) and p... | N/A   | -        | `npm run cli -- run project-health-check`      |
| **quality-scorer**            | Evaluates technical and textual quality based on IPA benchmarks and readability standards.           | N/A   | -        | `npm run cli -- run quality-scorer`            |
| **red-team-adversary**        | Performs active security "war gaming" by attempting to exploit identified vulnerabilities in a sa... | N/A   | -        | `npm run cli -- run red-team-adversary`        |
| **security-scanner**          | Scans the codebase for security risks, including hardcoded secrets (API keys, tokens), dangerous ... | N/A   | -        | `npm run cli -- run security-scanner`          |
| **skill-quality-auditor**     | Self-audit tool for the Gemini Skills monorepo. Ensures SKILL.md quality, script functionality, a... | N/A   | -        | `npm run cli -- run skill-quality-auditor`     |
| **supply-chain-sentinel**     | Protects the software supply chain by generating SBoMs and auditing dependency provenance. Monito... | N/A   | -        | `npm run cli -- run supply-chain-sentinel`     |

## 📂 BUSINESS

> Strategy, financial modeling, and executive reporting.

| Skill                                | Description                                                                                          | Score | Avg Time | Usage                                                 |
| :----------------------------------- | :--------------------------------------------------------------------------------------------------- | :---- | :------- | :---------------------------------------------------- |
| **business-growth-planner**          | Helps define long-term business goals, market entry strategies, and revenue streams. Translates C... | N/A   | -        | `npm run cli -- run business-growth-planner`          |
| **business-impact-analyzer**         | Translates engineering metrics (DORA, error rates, technical debt) into business KPIs and financi... | N/A   | -        | `npm run cli -- run business-impact-analyzer`         |
| **competitive-intel-strategist**     | Analyzes competitor releases and market trends to propose technical differentiation strategies. E... | N/A   | -        | `npm run cli -- run competitive-intel-strategist`     |
| **executive-reporting-maestro**      | Synthesizes technical data into professional external reports for PMOs and stakeholders. Focuses ... | N/A   | -        | `npm run cli -- run executive-reporting-maestro`      |
| **financial-modeling-maestro**       | Generates and analyzes financial models, P&L forecasts, and cash flow projections. Transforms bus... | N/A   | -        | `npm run cli -- run financial-modeling-maestro`       |
| **investor-readiness-audit**         | Prepares documents and audits for fundraising or board meetings. Ensures financial, technical, an... | N/A   | -        | `npm run cli -- run investor-readiness-audit`         |
| **ip-profitability-architect**       | Designs business and licensing models for internal intellectual property. Transforms IP from a pr... | N/A   | -        | `npm run cli -- run ip-profitability-architect`       |
| **ip-strategist**                    | Identifies and protects intellectual property within the codebase. Drafts initial patent applicat... | N/A   | -        | `npm run cli -- run ip-strategist`                    |
| **pmo-governance-lead**              | Fulfills the role of a PMO by overseeing project quality gates, risks, and cross-skill alignment.... | N/A   | -        | `npm run cli -- run pmo-governance-lead`              |
| **scenario-multiverse-orchestrator** | Generates multiple business scenarios (Growth/Stability/Hybrid) from financial and strategic assu... | N/A   | -        | `npm run cli -- run scenario-multiverse-orchestrator` |
| **stakeholder-communicator**         | Translates technical decisions and architectural changes into clear, business-oriented language f... | N/A   | -        | `npm run cli -- run stakeholder-communicator`         |
| **strategic-roadmap-planner**        | Analyzes code complexity, technical debt, and industry trends to propose a 3-month strategic road... | N/A   | -        | `npm run cli -- run strategic-roadmap-planner`        |
| **sunset-architect**                 | Manages the graceful decommissioning of underused or high-maintenance features. Plans deprecation... | N/A   | -        | `npm run cli -- run sunset-architect`                 |
| **talent-requirement-generator**     | Identifies the ideal human skills needed for the project's next phase. Analyzes technical debt, r... | N/A   | -        | `npm run cli -- run talent-requirement-generator`     |
| **tech-dd-analyst**                  | Performs Technical Due Diligence on startups. Analyzes code (if available) or evaluates public si... | N/A   | -        | `npm run cli -- run tech-dd-analyst`                  |
| **unit-economics-optimizer**         | Analyzes LTV, CAC, and churn to ensure product profitability. Proposes pricing and customer reten... | N/A   | -        | `npm run cli -- run unit-economics-optimizer`         |

## 📂 CONNECTOR

> Enterprise tool integrations (Jira, Slack, Box).

| Skill                           | Description                                                                                          | Score | Avg Time | Usage                                            |
| :------------------------------ | :--------------------------------------------------------------------------------------------------- | :---- | :------- | :----------------------------------------------- |
| **backlog-connector**           | Specialized connector for Nulab Backlog API. Automatically resolves Project IDs and handles pagin... | N/A   | -        | `npm run cli -- run backlog-connector`           |
| **box-connector**               | Securely connects to Box using the Node.js SDK (JWT). downloads files, searches content, and mana... | N/A   | -        | `npm run cli -- run box-connector`               |
| **connection-manager**          | Manages secure connections to external tools (AWS, Slack, Jira, Box). Validates credentials in th... | N/A   | -        | `npm run cli -- run connection-manager`          |
| **github-repo-auditor**         | Audits and classifies GitHub repositories into business solutions.                                   | N/A   | -        | `npm run cli -- run github-repo-auditor`         |
| **github-skills-manager**       | Comprehensive management suite for Gemini skills. Features an interactive dashboard to create, in... | N/A   | -        | `npm run cli -- run github-skills-manager`       |
| **google-workspace-integrator** | Automates Google Docs, Sheets, and Mail. Generates reports, tracks KPIs in spreadsheets, and draf... | N/A   | -        | `npm run cli -- run google-workspace-integrator` |
| **jira-agile-assistant**        | Automates Jira operations (Cloud/On-prem). Creates issues, updates sprints, and synchronizes the ... | 91 ✅ | 934ms    | `npm run cli -- run jira-agile-assistant`        |
| **slack-communicator-pro**      | Manages high-fidelity notifications and team engagement on Slack. Sends automated summaries, aler... | N/A   | -        | `npm run cli -- run slack-communicator-pro`      |

## 📂 CORE

> Fundamental orchestrators and self-evolution mechanisms.

| Skill                         | Description                                                                                          | Score  | Avg Time | Usage                                          |
| :---------------------------- | :--------------------------------------------------------------------------------------------------- | :----- | :------- | :--------------------------------------------- |
| **intent-classifier**         | Classify intent of text (request, question, report).                                                 | N/A    | -        | `npm run cli -- run intent-classifier`         |
| **mission-control**           | Orchestrates multiple skills to achieve high-level goals. Acts as the brain of the ecosystem to c... | 100 ✅ | 0ms      | `npm run cli -- run mission-control`           |
| **prompt-optimizer**          | Self-improves agent instructions and context handling. Analyzes failed or suboptimal responses to... | N/A    | -        | `npm run cli -- run prompt-optimizer`          |
| **self-evolution**            | Analyzes project history and failures to self-propose improvements to GEMINI.md or skill scripts.    | N/A    | -        | `npm run cli -- run self-evolution`            |
| **self-healing-orchestrator** | Automatically repairs known production issues by applying patches, rollbacks, or config changes. ... | N/A    | -        | `npm run cli -- run self-healing-orchestrator` |
| **skill-evolution-engine**    | Enables skills to self-improve by analyzing execution logs and user feedback. Automatically refin... | N/A    | -        | `npm run cli -- run skill-evolution-engine`    |

## 📂 ENGINEERING

> Development, implementation, and architectural refactoring tools.

| Skill                     | Description                                                                                          | Score | Avg Time | Usage                                      |
| :------------------------ | :--------------------------------------------------------------------------------------------------- | :---- | :------- | :----------------------------------------- |
| **binary-archaeologist**  | Reverse engineers legacy binaries and "black box" executables to extract logic and dependencies. ... | N/A   | -        | `npm run cli -- run binary-archaeologist`  |
| **code-lang-detector**    | Detect programming language of source code.                                                          | N/A   | -        | `npm run cli -- run code-lang-detector`    |
| **codebase-mapper**       | Maps the directory structure of the project to help the AI understand the codebase layout.           | N/A   | -        | `npm run cli -- run codebase-mapper`       |
| **dependency-grapher**    | Generate dependency graphs (Mermaid/DOT) from project files.                                         | N/A   | -        | `npm run cli -- run dependency-grapher`    |
| **dependency-lifeline**   | Proactively monitors and plans library updates. Assesses the risk of breaking changes and propose... | N/A   | -        | `npm run cli -- run dependency-lifeline`   |
| **kernel-compiler**       | Compiles core utilities into standalone binaries (Go/Rust) to reduce runtime dependencies. Ensure... | N/A   | -        | `npm run cli -- run kernel-compiler`       |
| **local-reviewer**        | Retrieves git diff of staged files for pre-commit AI code review.                                    | N/A   | -        | `npm run cli -- run local-reviewer`        |
| **mobile-test-generator** | Automatically generates Maestro YAML test flows based on provided scenarios and mobile automation... | N/A   | -        | `npm run cli -- run mobile-test-generator` |
| **pr-architect**          | Crafts descriptive and high-quality Pull Request bodies. Analyzes code changes to explain "Why", ... | N/A   | -        | `npm run cli -- run pr-architect`          |
| **refactoring-engine**    | Executes large-scale architectural refactoring and technical debt reduction across the entire cod... | N/A   | -        | `npm run cli -- run refactoring-engine`    |
| **schema-inspector**      | Automatically locates and displays schema definition files (SQL, Prisma, OpenAPI, etc.).             | N/A   | -        | `npm run cli -- run schema-inspector`      |
| **sequence-mapper**       | Generate Mermaid sequence diagrams from source code function calls.                                  | N/A   | -        | `npm run cli -- run sequence-mapper`       |
| **technology-porter**     | Executes large-scale migrations across language stacks (e.g., C++ to Rust, JS to Go). Preserves l... | N/A   | -        | `npm run cli -- run technology-porter`     |
| **test-genie**            | Executes the project's test suite and returns the output for AI analysis.                            | N/A   | -        | `npm run cli -- run test-genie`            |
| **test-suite-architect**  | Generates comprehensive test code (Jest, Pytest, Cypress) from requirements and test viewpoints. ... | N/A   | -        | `npm run cli -- run test-suite-architect`  |

## 📂 INTELLIGENCE

> Knowledge harvesting and 3-tier memory management.

| Skill                   | Description                                                                                          | Score | Avg Time | Usage                                    |
| :---------------------- | :--------------------------------------------------------------------------------------------------- | :---- | :------- | :--------------------------------------- |
| **auto-context-mapper** | Intelligently links related knowledge assets across tiers. Automatically fetches prerequisite dat... | N/A   | -        | `npm run cli -- run auto-context-mapper` |
| **data-collector**      | Fetches data from URLs (Web/API) and saves it to a local directory with metadata (timestamp, sour... | N/A   | -        | `npm run cli -- run data-collector`      |
| **data-transformer**    | Convert between CSV, JSON, and YAML formats.                                                         | N/A   | -        | `npm run cli -- run data-transformer`    |
| **dataset-curator**     | Prepares and audits high-quality datasets for AI/RAG applications. Cleans noise, structure data, ... | N/A   | -        | `npm run cli -- run dataset-curator`     |
| **db-extractor**        | Extract schema and sample data from databases for analysis.                                          | N/A   | -        | `npm run cli -- run db-extractor`        |
| **glossary-resolver**   | Resolve terms using glossary.                                                                        | N/A   | -        | `npm run cli -- run glossary-resolver`   |
| **knowledge-auditor**   | Audits the 3-tier knowledge base for consistency, freshness, and cross-tier contradictions. Ensur... | N/A   | -        | `npm run cli -- run knowledge-auditor`   |
| **knowledge-fetcher**   | Fetch knowledge from both public and confidential directories. Bridges general best practices wit... | N/A   | -        | `npm run cli -- run knowledge-fetcher`   |
| **knowledge-harvester** | Clones external Git repositories and analyzes them to extract valuable knowledge. Converts discov... | N/A   | -        | `npm run cli -- run knowledge-harvester` |
| **knowledge-refiner**   | Maintains and consolidates the knowledge base. Cleans up unstructured data and merges it into str... | N/A   | -        | `npm run cli -- run knowledge-refiner`   |
| **source-importer**     | Securely imports external source code into the ecosystem's quarantine area with mandatory securit... | N/A   | -        | `npm run cli -- run source-importer`     |
| **sovereign-memory**    | Multi-tier, persistent memory hub. Manages facts across Personal, Confidential, and Public tiers ... | N/A   | -        | `npm run cli -- run sovereign-memory`    |
| **sovereign-sync**      | Syncs specific knowledge tiers with external private repositories.                                   | N/A   | -        | `npm run cli -- run sovereign-sync`      |

## 📂 MEDIA

> Professional document extraction and media asset generation.

| Skill                 | Description                                                                                          | Score | Avg Time | Usage                                  |
| :-------------------- | :--------------------------------------------------------------------------------------------------- | :---- | :------- | :------------------------------------- |
| **audio-transcriber** | Transcribe audio/video files to text using OpenAI Whisper.                                           | N/A   | -        | `npm run cli -- run audio-transcriber` |
| **diagram-renderer**  | Converts diagram code (Mermaid, PlantUML) into image files (PNG/SVG). Useful for visualizing text... | N/A   | -        | `npm run cli -- run diagram-renderer`  |
| **doc-to-text**       | Extract text content from various file formats. Supports PDF, Excel, Word, Images (OCR), Email, a... | N/A   | -        | `npm run cli -- run doc-to-text`       |
| **excel-artisan**     | Generates and edits Excel (.xlsx) files. Capable of converting JSON/CSV/HTML to Excel, modifying ... | N/A   | -        | `npm run cli -- run excel-artisan`     |
| **html-reporter**     | Generate standalone HTML reports from JSON/Markdown.                                                 | N/A   | -        | `npm run cli -- run html-reporter`     |
| **layout-architect**  | Converts visual designs (images/screenshots) into implementation code (CSS, Python-pptx, HTML). U... | N/A   | -        | `npm run cli -- run layout-architect`  |
| **pdf-composer**      | Generate PDF documents from Markdown with headers/footers.                                           | N/A   | -        | `npm run cli -- run pdf-composer`      |
| **ppt-artisan**       | Create and convert PowerPoint presentations from Markdown using Marp. Use when the user wants to ... | N/A   | -        | `npm run cli -- run ppt-artisan`       |
| **word-artisan**      | Generate Word documents (.docx) from Markdown.                                                       | N/A   | -        | `npm run cli -- run word-artisan`      |

## 📂 UTILITIES

> Shared helpers, background daemons, and general utilities.

| Skill                             | Description                                                                                          | Score | Avg Time | Usage                                              |
| :-------------------------------- | :--------------------------------------------------------------------------------------------------- | :---- | :------- | :------------------------------------------------- |
| **agent-activity-monitor**        | Collects and visualizes statistics regarding the agent's activities, including skill usage, execu... | N/A   | -        | `npm run cli -- run agent-activity-monitor`        |
| **ai-model-orchestrator**         | Dynamically selects the optimal AI model based on task complexity, cost, and latency. Routes requ... | N/A   | -        | `npm run cli -- run ai-model-orchestrator`         |
| **api-doc-generator**             | Generate API documentation from OpenAPI specs or code.                                               | N/A   | -        | `npm run cli -- run api-doc-generator`             |
| **api-evolution-manager**         | Governs the evolution of public APIs. Detects breaking changes, manages deprecation cycles, and g... | N/A   | -        | `npm run cli -- run api-evolution-manager`         |
| **api-fetcher**                   | Fetch data from REST/GraphQL APIs securely.                                                          | N/A   | -        | `npm run cli -- run api-fetcher`                   |
| **automated-support-architect**   | Generates high-quality user support assets (FAQs, Troubleshooting Guides, Chatbot Knowledge) dire... | N/A   | -        | `npm run cli -- run automated-support-architect`   |
| **autonomous-skill-designer**     | The ultimate "self-generation" skill. Autonomously designs and implements new Gemini skills to so... | N/A   | -        | `npm run cli -- run autonomous-skill-designer`     |
| **boilerplate-genie**             | Scaffolds new projects with best practices (CI/CD, Tests, Linting) pre-configured. Ensures a "hea... | N/A   | -        | `npm run cli -- run boilerplate-genie`             |
| **browser-navigator**             | Automates browser actions using Playwright CLI. Can record, replay, and generate browser automati... | N/A   | -        | `npm run cli -- run browser-navigator`             |
| **budget-variance-tracker**       | Compares actual spend and revenue against forecasts. Provides variance analysis and corrective in... | N/A   | -        | `npm run cli -- run budget-variance-tracker`       |
| **chaos-monkey-orchestrator**     | Injects managed chaos into environments to test system resilience. Validates that self-healing an... | N/A   | -        | `npm run cli -- run chaos-monkey-orchestrator`     |
| **cloud-cost-estimator**          | Estimates monthly cloud infrastructure costs from IaC files (Terraform, CloudFormation). Helps al... | N/A   | -        | `npm run cli -- run cloud-cost-estimator`          |
| **cloud-waste-hunter**            | Actively identifies and eliminates unused or over-provisioned cloud resources. Goes beyond estima... | N/A   | -        | `npm run cli -- run cloud-waste-hunter`            |
| **completeness-scorer**           | Evaluate text completeness based on criteria.                                                        | N/A   | -        | `npm run cli -- run completeness-scorer`           |
| **context-injector**              | Inject knowledge into JSON data context.                                                             | N/A   | -        | `npm run cli -- run context-injector`              |
| **crisis-manager**                | Provides rapid response during production incidents or critical security breaches. Coordinates di... | N/A   | -        | `npm run cli -- run crisis-manager`                |
| **data-anonymizer**               | Masks sensitive fields in JSON data for safe sharing.                                                | N/A   | -        | `npm run cli -- run data-anonymizer`               |
| **data-lineage-guardian**         | Tracks the flow and integrity of data across the entire stack. Monitors data quality, ensures "Ri... | N/A   | -        | `npm run cli -- run data-lineage-guardian`         |
| **diff-visualizer**               | Generate a visual difference report between two texts.                                               | N/A   | -        | `npm run cli -- run diff-visualizer`               |
| **disaster-recovery-planner**     | Generates actionable Disaster Recovery (DR) runbooks from infrastructure and requirements. Valida... | N/A   | -        | `npm run cli -- run disaster-recovery-planner`     |
| **doc-sync-sentinel**             | Automatically synchronizes documentation with code changes. Detects drift between source code and... | N/A   | -        | `npm run cli -- run doc-sync-sentinel`             |
| **doc-type-classifier**           | Classify document type (meeting-notes, spec, etc).                                                   | N/A   | -        | `npm run cli -- run doc-type-classifier`           |
| **document-generator**            | Unified gateway for all document generation tasks. Automatically routes to specialized artisan sk... | N/A   | -        | `npm run cli -- run document-generator`            |
| **domain-classifier**             | Classify domain (tech, finance, legal).                                                              | N/A   | -        | `npm run cli -- run domain-classifier`             |
| **ecosystem-integration-test**    | Validates the interoperability between skills. Ensures that output formats (JSON/Markdown) from o... | N/A   | -        | `npm run cli -- run ecosystem-integration-test`    |
| **encoding-detector**             | Detect file encoding and line endings.                                                               | N/A   | -        | `npm run cli -- run encoding-detector`             |
| **environment-provisioner**       | Generates Infrastructure as Code (Terraform, Docker, K8s) based on interactive requirements. The ... | N/A   | -        | `npm run cli -- run environment-provisioner`       |
| **format-detector**               | Detect text format (JSON, YAML, CSV, etc.) and confidence.                                           | N/A   | -        | `npm run cli -- run format-detector`               |
| **issue-to-solution-bridge**      | Automates the entire lifecycle from issue detection to solution. Interprets bug reports or featur... | N/A   | -        | `npm run cli -- run issue-to-solution-bridge`      |
| **lang-detector**                 | Detect natural language of text (ja, en, etc.).                                                      | N/A   | -        | `npm run cli -- run lang-detector`                 |
| **log-analyst**                   | Reads the tail of a log file to help analyze recent errors or behavior.                              | N/A   | -        | `npm run cli -- run log-analyst`                   |
| **log-to-requirement-bridge**     | Analyzes runtime errors and logs to draft improvement requirements. Bridges the gap between Opera... | N/A   | -        | `npm run cli -- run log-to-requirement-bridge`     |
| **nonfunctional-architect**       | Interactive guide for defining non-functional requirements based on IPA "Non-Functional Requireme... | N/A   | -        | `npm run cli -- run nonfunctional-architect`       |
| **onboarding-wizard**             | Generates a personalized project guide for new members. Analyzes the codebase and skills to help ... | N/A   | -        | `npm run cli -- run onboarding-wizard`             |
| **operational-runbook-generator** | Generates detailed, step-by-step operational runbooks for day-to-day tasks (scaling, patching, up... | N/A   | -        | `npm run cli -- run operational-runbook-generator` |
| **performance-monitor-analyst**   | Correlates performance targets with actual profiling results. Identifies bottlenecks and validate... | N/A   | -        | `npm run cli -- run performance-monitor-analyst`   |
| **release-note-crafter**          | Generates business-value-focused release notes by correlating Git logs with requirements. Focuses... | N/A   | -        | `npm run cli -- run release-note-crafter`          |
| **requirements-wizard**           | Guide for creating and reviewing requirements definitions based on IPA standards. Provides best p... | N/A   | -        | `npm run cli -- run requirements-wizard`           |
| **schema-validator**              | Validate JSON against schemas and identify best match.                                               | N/A   | -        | `npm run cli -- run schema-validator`              |
| **sensitivity-detector**          | Detect PII and sensitive information in text.                                                        | N/A   | -        | `npm run cli -- run sensitivity-detector`          |
| **shadow-dispatcher**             | Executes a task in parallel using two different agent personas (Shadow Execution) and synthesizes... | N/A   | -        | `npm run cli -- run shadow-dispatcher`             |
| **skill-bundle-packager**         | Dynamically bundles mission-specific skills into specialized subsets. Optimizes agent performance... | N/A   | -        | `npm run cli -- run skill-bundle-packager`         |
| **sustainability-consultant**     | Estimates the environmental impact (Carbon Footprint) of code and infrastructure. Recommends opti... | N/A   | -        | `npm run cli -- run sustainability-consultant`     |
| **tech-stack-librarian**          | Autonomously researches and compiles best practices for specific tools (SaaS/OSS). Fetches offici... | N/A   | -        | `npm run cli -- run tech-stack-librarian`          |
| **telemetry-insight-engine**      | Analyzes real-world telemetry and usage data to identify feature gaps and usability issues. Feeds... | N/A   | -        | `npm run cli -- run telemetry-insight-engine`      |
| **template-renderer**             | Render text from templates (Mustache/EJS) and data.                                                  | N/A   | -        | `npm run cli -- run template-renderer`             |
| **terraform-arch-mapper**         | Generates a system architecture diagram from Terraform code. It parses .tf files to identify reso... | N/A   | -        | `npm run cli -- run terraform-arch-mapper`         |
| **test-viewpoint-analyst**        | Generates and reviews test scenarios based on IPA non-functional grade standards. Analyzes system... | N/A   | -        | `npm run cli -- run test-viewpoint-analyst`        |
| **asset-token-economist**         | Minimizes token consumption and costs by optimizing data input. Performs smart summarization and ... | N/A   | -        | `npm run cli -- run asset-token-economist`         |
| **visionary-ethos-keeper**        | Ensures decisions and proposals align with company mission, values, and ethical guidelines. Check... | N/A   | -        | `npm run cli -- run visionary-ethos-keeper`        |

## 📂 UX

> Human-centric UI/UX auditing and voice interface control.

| Skill                         | Description                                                                                          | Score | Avg Time | Usage                                          |
| :---------------------------- | :--------------------------------------------------------------------------------------------------- | :---- | :------- | :--------------------------------------------- |
| **biometric-context-adapter** | Infers user stress/energy levels from interaction patterns (typing speed, error rate). Adjusts re... | N/A   | -        | `npm run cli -- run biometric-context-adapter` |
| **localization-maestro**      | Manages global expansion by automating i18n workflows and auditing for cultural/regional appropri... | N/A   | -        | `npm run cli -- run localization-maestro`      |
| **synthetic-user-persona**    | Generates diverse AI user personas to autonomously test applications. Simulates beginners, power ... | N/A   | -        | `npm run cli -- run synthetic-user-persona`    |
| **ux-auditor**                | Performs visual and structural UX/Accessibility audits on web interfaces. Analyzes screenshots to... | N/A   | -        | `npm run cli -- run ux-auditor`                |
| **ux-visualizer**             | Analyzes source code or requirements to generate high-fidelity screen and state transition diagra... | N/A   | -        | `npm run cli -- run ux-visualizer`             |
| **voice-command-listener**    | Captures microphone input and transcribes it into text commands. Uses SoX for recording and OpenA... | N/A   | -        | `npm run cli -- run voice-command-listener`    |
| **voice-interface-maestro**   | Converts text responses into spoken audio (TTS). Supports multiple voice personas (Professional, ... | N/A   | -        | `npm run cli -- run voice-interface-maestro`   |

---

_Generated by Ecosystem Architect Tool | Based on Hierarchical Namespace Model v1.0_
