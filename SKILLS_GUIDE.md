# Gemini Skills Ecosystem Guide

Total Skills: 130
Last updated: 2026/2/10

This guide is automatically generated from the monorepo source.

## Available Skills

| Skill | Description | Usage |
| :--- | :--- | :--- |
| **agent-activity-monitor** | Collects and visualizes statistics regarding the agent's activities, including skill usage, execution success rates, and task duration. Provides a data-driven dashboard for ecosystem health. | `npm run cli -- execute agent-activity-monitor` |
| **ai-ethics-auditor** | Audits AI systems for bias, fairness, and privacy. Analyzes prompts and datasets to ensure ethical and safe AI implementation. | `npm run cli -- execute ai-ethics-auditor` |
| **ai-model-orchestrator** | Dynamically selects the optimal AI model based on task complexity, cost, and latency. Routes requests to Gemini, GPT-4, Claude, or local LLMs to maximize efficiency. | `npm run cli -- execute ai-model-orchestrator` |
| **api-doc-generator** | Generate API documentation from OpenAPI specs or code. | `npm run cli -- execute api-doc-generator` |
| **api-evolution-manager** | Governs the evolution of public APIs. Detects breaking changes, manages deprecation cycles, and generates migration guides for clients. | `npm run cli -- execute api-evolution-manager` |
| **api-fetcher** | Fetch data from REST/GraphQL APIs securely. | `npm run cli -- execute api-fetcher` |
| **audio-transcriber** | Transcribe audio/video files to text using OpenAI Whisper. | `npm run cli -- execute audio-transcriber` |
| **auto-context-mapper** | Intelligently links related knowledge assets across tiers. Automatically fetches prerequisite data and high-level mission context for any task. | `npm run cli -- execute auto-context-mapper` |
| **automated-support-architect** | Generates high-quality user support assets (FAQs, Troubleshooting Guides, Chatbot Knowledge) directly from source code and requirements. Bridges the gap between developers and end-users. | `npm run cli -- execute automated-support-architect` |
| **autonomous-skill-designer** | The ultimate "self-generation" skill. Autonomously designs and implements new Gemini skills to solve novel problems that current skills cannot address. | `npm run cli -- execute autonomous-skill-designer` |
| **backlog-connector** | Specialized connector for Nulab Backlog API. Automatically resolves Project IDs and handles pagination for fetching issues and wikis. | `npm run cli -- execute backlog-connector` |
| **binary-archaeologist** | Reverse engineers legacy binaries and "black box" executables to extract logic and dependencies. Re-integrates lost institutional assets into modern codebases. | `npm run cli -- execute binary-archaeologist` |
| **biometric-context-adapter** | Infers user stress/energy levels from interaction patterns (typing speed, error rate). Adjusts response verbosity and visualizes mood via a "Niko-Niko Calendar." | `npm run cli -- execute biometric-context-adapter` |
| **boilerplate-genie** | Scaffolds new projects with best practices (CI/CD, Tests, Linting) pre-configured. Ensures a "healthy" starting point for Next.js, FastAPI, Node.js, and more. | `npm run cli -- execute boilerplate-genie` |
| **box-connector** | Securely connects to Box using the Node.js SDK (JWT). downloads files, searches content, and manages folder structures. | `npm run cli -- execute box-connector` |
| **browser-navigator** | Automates browser actions using Playwright CLI. Can record, replay, and generate browser automation scenarios stored in the knowledge base. Useful for UI testing, data extraction, and visual auditing. | `npm run cli -- execute browser-navigator` |
| **budget-variance-tracker** | Compares actual spend and revenue against forecasts. Provides variance analysis and corrective insights to ensure financial discipline. | `npm run cli -- execute budget-variance-tracker` |
| **bug-predictor** | Predicts future bug hotspots by analyzing code complexity, churn, and historical defect patterns. Warns developers before a bug is even written. | `npm run cli -- execute bug-predictor` |
| **business-growth-planner** | Helps define long-term business goals, market entry strategies, and revenue streams. Translates CEO vision into structured OKRs and growth pillars. | `npm run cli -- execute business-growth-planner` |
| **business-impact-analyzer** | Translates engineering metrics (DORA, error rates, technical debt) into business KPIs and financial impact. Helps justify technical investments to stakeholders. | `npm run cli -- execute business-impact-analyzer` |
| **chaos-monkey-orchestrator** | Injects managed chaos into environments to test system resilience. Validates that self-healing and monitoring systems work as expected under stress. | `npm run cli -- execute chaos-monkey-orchestrator` |
| **cloud-cost-estimator** | Estimates monthly cloud infrastructure costs from IaC files (Terraform, CloudFormation). Helps align architecture with budget constraints. | `npm run cli -- execute cloud-cost-estimator` |
| **cloud-waste-hunter** | Actively identifies and eliminates unused or over-provisioned cloud resources. Goes beyond estimation to hunt for actual cost savings in live environments. | `npm run cli -- execute cloud-waste-hunter` |
| **code-lang-detector** | Detect programming language of source code. | `npm run cli -- execute code-lang-detector` |
| **codebase-mapper** | Maps the directory structure of the project to help the AI understand the codebase layout. | `npm run cli -- execute codebase-mapper` |
| **competitive-intel-strategist** | Analyzes competitor releases and market trends to propose technical differentiation strategies. Ensures our products stay ahead by leveraging our unique code assets. | `npm run cli -- execute competitive-intel-strategist` |
| **completeness-scorer** | Evaluate text completeness based on criteria. | `npm run cli -- execute completeness-scorer` |
| **compliance-officer** | Maps technical state to regulatory standards (SOC2, ISO27001, etc.). Generates real-time compliance scores and audit-ready evidence reports. | `npm run cli -- execute compliance-officer` |
| **connection-manager** | Manages secure connections to external tools (AWS, Slack, Jira, Box). Validates credentials in the Personal Tier and injects them into the execution context. | `npm run cli -- execute connection-manager` |
| **context-injector** | Inject knowledge into JSON data context. | `npm run cli -- execute context-injector` |
| **crisis-manager** | Provides rapid response during production incidents or critical security breaches. Coordinates diagnostics, temporary fixes, and post-mortem data collection. | `npm run cli -- execute crisis-manager` |
| **data-collector** | Fetches data from URLs (Web/API) and saves it to a local directory with metadata (timestamp, source, hash) for traceability. Supports incremental updates. | `npm run cli -- execute data-collector` |
| **data-lineage-guardian** | Tracks the flow and integrity of data across the entire stack. Monitors data quality, ensures "Right to be Forgotten" compliance, and visualizes data lineage. | `npm run cli -- execute data-lineage-guardian` |
| **data-transformer** | Convert between CSV, JSON, and YAML formats. | `npm run cli -- execute data-transformer` |
| **dataset-curator** | Prepares and audits high-quality datasets for AI/RAG applications. Cleans noise, structure data, and ensures privacy compliance in knowledge bases. | `npm run cli -- execute dataset-curator` |
| **db-extractor** | Extract schema and sample data from databases for analysis. | `npm run cli -- execute db-extractor` |
| **dependency-grapher** | Generate dependency graphs (Mermaid/DOT) from project files. | `npm run cli -- execute dependency-grapher` |
| **dependency-lifeline** | Proactively monitors and plans library updates. Assesses the risk of breaking changes and proposes safe update paths. | `npm run cli -- execute dependency-lifeline` |
| **diagram-renderer** | Converts diagram code (Mermaid, PlantUML) into image files (PNG/SVG). Useful for visualizing text-based architecture diagrams, flowcharts, and sequence diagrams. | `npm run cli -- execute diagram-renderer` |
| **diff-visualizer** | Generate a visual difference report between two texts. | `npm run cli -- execute diff-visualizer` |
| **disaster-recovery-planner** | Generates actionable Disaster Recovery (DR) runbooks from infrastructure and requirements. Validates IaC for resilience (backups, redundancy). | `npm run cli -- execute disaster-recovery-planner` |
| **doc-sync-sentinel** | Automatically synchronizes documentation with code changes. Detects drift between source code and READMEs, Wikis, or comments, and suggests autonomous updates. | `npm run cli -- execute doc-sync-sentinel` |
| **doc-to-text** | Extract text content from various file formats. Supports PDF, Excel, Word, Images (OCR), Email, and ZIP Archives. Use for summarizing or analyzing binary files. | `npm run cli -- execute doc-to-text` |
| **doc-type-classifier** | Classify document type (meeting-notes, spec, etc). | `npm run cli -- execute doc-type-classifier` |
| **document-generator** | Unified gateway for all document generation tasks. Automatically routes to specialized artisan skills based on the requested format (PDF, DOCX, XLSX, PPTX, HTML). | `npm run cli -- execute document-generator` |
| **domain-classifier** | Classify domain (tech, finance, legal). | `npm run cli -- execute domain-classifier` |
| **ecosystem-integration-test** | Validates the interoperability between skills. Ensures that output formats (JSON/Markdown) from one skill are correctly consumed by the next in a chain. | `npm run cli -- execute ecosystem-integration-test` |
| **encoding-detector** | Detect file encoding and line endings. | `npm run cli -- execute encoding-detector` |
| **environment-provisioner** | Generates Infrastructure as Code (Terraform, Docker, K8s) based on interactive requirements. The creative counterpart to terraform-arch-mapper. | `npm run cli -- execute environment-provisioner` |
| **excel-artisan** | Generates and edits Excel (.xlsx) files. Capable of converting JSON/CSV/HTML to Excel, modifying cell values, and applying basic formatting. Use when you need to produce Excel reports or modify existing spreadsheets. | `npm run cli -- execute excel-artisan` |
| **executive-reporting-maestro** | Synthesizes technical data into professional external reports for PMOs and stakeholders. Focuses on ROI, milestones, and high-level project health. | `npm run cli -- execute executive-reporting-maestro` |
| **financial-modeling-maestro** | Generates and analyzes financial models, P&L forecasts, and cash flow projections. Transforms business assumptions into multi-year financial statements. | `npm run cli -- execute financial-modeling-maestro` |
| **format-detector** | Detect text format (JSON, YAML, CSV, etc.) and confidence. | `npm run cli -- execute format-detector` |
| **github-repo-auditor** | Audits and classifies GitHub repositories into business solutions. | `npm run cli -- execute github-repo-auditor` |
| **github-skills-manager** | Comprehensive management suite for Gemini skills. Features an interactive dashboard to create, install, sync (git), and manage dependencies for skills in a monorepo or individual repositories. | `npm run cli -- execute github-skills-manager` |
| **glossary-resolver** | Resolve terms using glossary. | `npm run cli -- execute glossary-resolver` |
| **google-workspace-integrator** | Automates Google Docs, Sheets, and Mail. Generates reports, tracks KPIs in spreadsheets, and drafts professional emails for stakeholders. | `npm run cli -- execute google-workspace-integrator` |
| **html-reporter** | Generate standalone HTML reports from JSON/Markdown. | `npm run cli -- execute html-reporter` |
| **intent-classifier** | Classify intent of text (request, question, report). | `npm run cli -- execute intent-classifier` |
| **investor-readiness-audit** | Prepares documents and audits for fundraising or board meetings. Ensures financial, technical, and compliance data is boardroom-ready. | `npm run cli -- execute investor-readiness-audit` |
| **ip-profitability-architect** | Designs business and licensing models for internal intellectual property. Transforms IP from a protection cost into a revenue-generating asset. | `npm run cli -- execute ip-profitability-architect` |
| **ip-strategist** | Identifies and protects intellectual property within the codebase. Drafts initial patent applications and IP reports for innovative algorithms or designs. | `npm run cli -- execute ip-strategist` |
| **issue-to-solution-bridge** | Automates the entire lifecycle from issue detection to solution. Interprets bug reports or feature requests and orchestrates other skills to implement and test the fix. | `npm run cli -- execute issue-to-solution-bridge` |
| **jira-agile-assistant** | Automates Jira operations (Cloud/On-prem). Creates issues, updates sprints, and synchronizes the backlog with the technical roadmap. | `npm run cli -- execute jira-agile-assistant` |
| **kernel-compiler** | Compiles core utilities into standalone binaries (Go/Rust) to reduce runtime dependencies. Ensures the ecosystem's "Self-Bootstrapping" capability. | `npm run cli -- execute kernel-compiler` |
| **knowledge-auditor** | Audits the 3-tier knowledge base for consistency, freshness, and cross-tier contradictions. Ensures that proprietary standards align with (or intentionally override) public ones. | `npm run cli -- execute knowledge-auditor` |
| **knowledge-fetcher** | Fetch knowledge from both public and confidential directories. Bridges general best practices with proprietary internal standards. | `npm run cli -- execute knowledge-fetcher` |
| **knowledge-harvester** | Clones external Git repositories and analyzes them to extract valuable knowledge. Converts discovered prompts, rules, and patterns into local knowledge assets. | `npm run cli -- execute knowledge-harvester` |
| **knowledge-refiner** | Maintains and consolidates the knowledge base. Cleans up unstructured data and merges it into structured glossaries or patterns. | `npm run cli -- execute knowledge-refiner` |
| **lang-detector** | Detect natural language of text (ja, en, etc.). | `npm run cli -- execute lang-detector` |
| **layout-architect** | Converts visual designs (images/screenshots) into implementation code (CSS, Python-pptx, HTML). Use when recreating slide layouts or UI designs from images. | `npm run cli -- execute layout-architect` |
| **license-auditor** | Scans project dependencies for license compliance risks. Identifies restrictive licenses (GPL, AGPL) and generates mandatory attribution (NOTICE) files. | `npm run cli -- execute license-auditor` |
| **local-reviewer** | Retrieves git diff of staged files for pre-commit AI code review. | `npm run cli -- execute local-reviewer` |
| **localization-maestro** | Manages global expansion by automating i18n workflows and auditing for cultural/regional appropriateness. Handles formats, currency, and sensitive localized expressions. | `npm run cli -- execute localization-maestro` |
| **log-analyst** | Reads the tail of a log file to help analyze recent errors or behavior. | `npm run cli -- execute log-analyst` |
| **log-to-requirement-bridge** | Analyzes runtime errors and logs to draft improvement requirements. Bridges the gap between Operations and Development. | `npm run cli -- execute log-to-requirement-bridge` |
| **mission-control** | Orchestrates multiple skills to achieve high-level goals. Acts as the brain of the ecosystem to coordinate complex workflows across the SDLC. | `npm run cli -- execute mission-control` |
| **monitoring-config-auditor** | Audits infrastructure code (Terraform, K8s) for monitoring compliance. Ensures alarms, thresholds, and notification paths are set up correctly according to best practices. | `npm run cli -- execute monitoring-config-auditor` |
| **nonfunctional-architect** | Interactive guide for defining non-functional requirements based on IPA "Non-Functional Requirements Grade 2018". Helps users select appropriate service levels (Availability, Performance, Security, etc.) and generates a requirements definition document. | `npm run cli -- execute nonfunctional-architect` |
| **onboarding-wizard** | Generates a personalized project guide for new members. Analyzes the codebase and skills to help someone get productive in day one. | `npm run cli -- execute onboarding-wizard` |
| **operational-runbook-generator** | Generates detailed, step-by-step operational runbooks for day-to-day tasks (scaling, patching, updates). Ensures consistency and safety with built-in rollback procedures. | `npm run cli -- execute operational-runbook-generator` |
| **pdf-composer** | Generate PDF documents from Markdown with headers/footers. | `npm run cli -- execute pdf-composer` |
| **performance-monitor-analyst** | Correlates performance targets with actual profiling results. Identifies bottlenecks and validates against non-functional requirements. | `npm run cli -- execute performance-monitor-analyst` |
| **pmo-governance-lead** | Fulfills the role of a PMO by overseeing project quality gates, risks, and cross-skill alignment. Enforces IPA and industry standards across the lifecycle. | `npm run cli -- execute pmo-governance-lead` |
| **post-quantum-shield** | Audits codebases for quantum-vulnerable cryptography and plans migration to Post-Quantum Cryptography (PQC) standards to ensure long-term data security. | `npm run cli -- execute post-quantum-shield` |
| **ppt-artisan** | Create and convert PowerPoint presentations from Markdown using Marp. Use when the user wants to generate slides, manage themes, or convert MD to PPTX/PDF. | `npm run cli -- execute ppt-artisan` |
| **pr-architect** | Crafts descriptive and high-quality Pull Request bodies. Analyzes code changes to explain "Why", "How", and the "Impact" of the work. | `npm run cli -- execute pr-architect` |
| **project-health-check** | Audits the project for modern and Waterfall standards (SDLC, CI/CD, Tests, Quality Metrics) and provides a health score with improvement suggestions. | `npm run cli -- execute project-health-check` |
| **prompt-optimizer** | Self-improves agent instructions and context handling. Analyzes failed or suboptimal responses to refine system prompts and prompt templates. | `npm run cli -- execute prompt-optimizer` |
| **quality-scorer** | Evaluates technical and textual quality based on IPA benchmarks and readability standards. | `npm run cli -- execute quality-scorer` |
| **red-team-adversary** | Performs active security "war gaming" by attempting to exploit identified vulnerabilities in a sandbox. Validates threat reality beyond static scans. | `npm run cli -- execute red-team-adversary` |
| **refactoring-engine** | Executes large-scale architectural refactoring and technical debt reduction across the entire codebase. Ensures consistency with modern design patterns. | `npm run cli -- execute refactoring-engine` |
| **release-note-crafter** | Generates business-value-focused release notes by correlating Git logs with requirements. Focuses on "what's new" for users and stakeholders. | `npm run cli -- execute release-note-crafter` |
| **requirements-wizard** | Guide for creating and reviewing requirements definitions based on IPA standards. Provides best practices for business analysis, process mapping, data modeling, and review checklists. | `npm run cli -- execute requirements-wizard` |
| **scenario-multiverse-orchestrator** | Generates multiple business scenarios (Growth/Stability/Hybrid) from financial and strategic assumptions for executive decision-making. | `npm run cli -- execute scenario-multiverse-orchestrator` |
| **schema-inspector** | Automatically locates and displays schema definition files (SQL, Prisma, OpenAPI, etc.). | `npm run cli -- execute schema-inspector` |
| **schema-validator** | Validate JSON against schemas and identify best match. | `npm run cli -- execute schema-validator` |
| **security-scanner** | Scans the codebase for security risks, including hardcoded secrets (API keys, tokens), dangerous code patterns (eval, shell injection), and insecure configurations. Use to audit code before committing or reviewing. | `npm run cli -- execute security-scanner` |
| **self-healing-orchestrator** | Automatically repairs known production issues by applying patches, rollbacks, or config changes. The autonomous counterpart to crisis-manager. | `npm run cli -- execute self-healing-orchestrator` |
| **sensitivity-detector** | Detect PII and sensitive information in text. | `npm run cli -- execute sensitivity-detector` |
| **sequence-mapper** | Generate Mermaid sequence diagrams from source code function calls. | `npm run cli -- execute sequence-mapper` |
| **skill-bundle-packager** | Dynamically bundles mission-specific skills into specialized subsets. Optimizes agent performance by focusing on relevant tools for specific high-level tasks. | `npm run cli -- execute skill-bundle-packager` |
| **skill-evolution-engine** | Enables skills to self-improve by analyzing execution logs and user feedback. Automatically refines SKILL.md and scripts to fix recurring failures. | `npm run cli -- execute skill-evolution-engine` |
| **skill-quality-auditor** | Self-audit tool for the Gemini Skills monorepo. Ensures SKILL.md quality, script functionality, and test coverage for all skills. | `npm run cli -- execute skill-quality-auditor` |
| **slack-communicator-pro** | Manages high-fidelity notifications and team engagement on Slack. Sends automated summaries, alerts, and strategic announcements. | `npm run cli -- execute slack-communicator-pro` |
| **sovereign-memory** | Multi-tier, persistent memory hub. Manages facts across Personal, Confidential, and Public tiers in accordance with the Sovereign Knowledge Protocol. | `npm run cli -- execute sovereign-memory` |
| **sovereign-sync** | Syncs specific knowledge tiers with external private repositories. | `npm run cli -- execute sovereign-sync` |
| **stakeholder-communicator** | Translates technical decisions and architectural changes into clear, business-oriented language for non-technical stakeholders (Execs, Marketing, Sales). | `npm run cli -- execute stakeholder-communicator` |
| **strategic-roadmap-planner** | Analyzes code complexity, technical debt, and industry trends to propose a 3-month strategic roadmap. Aligns engineering effort with business ROI. | `npm run cli -- execute strategic-roadmap-planner` |
| **sunset-architect** | Manages the graceful decommissioning of underused or high-maintenance features. Plans deprecation cycles, handles data archiving, and generates migration paths for legacy users. | `npm run cli -- execute sunset-architect` |
| **supply-chain-sentinel** | Protects the software supply chain by generating SBoMs and auditing dependency provenance. Monitors for malicious packages and maintenance risks. | `npm run cli -- execute supply-chain-sentinel` |
| **sustainability-consultant** | Estimates the environmental impact (Carbon Footprint) of code and infrastructure. Recommends optimizations for energy efficiency and "GreenOps". | `npm run cli -- execute sustainability-consultant` |
| **synthetic-user-persona** | Generates diverse AI user personas to autonomously test applications. Simulates beginners, power users, and users with accessibility needs to discover hidden UI/UX flaws. | `npm run cli -- execute synthetic-user-persona` |
| **talent-requirement-generator** | Identifies the ideal human skills needed for the project's next phase. Analyzes technical debt, roadmap, and current team gaps to generate job descriptions and coding challenges. | `npm run cli -- execute talent-requirement-generator` |
| **tech-dd-analyst** | Performs Technical Due Diligence on startups. Analyzes code (if available) or evaluates public signals (hiring, blogs) to assess technical risk and team maturity. | `npm run cli -- execute tech-dd-analyst` |
| **tech-stack-librarian** | Autonomously researches and compiles best practices for specific tools (SaaS/OSS). Fetches official docs and structures them into the knowledge base. | `npm run cli -- execute tech-stack-librarian` |
| **technology-porter** | Executes large-scale migrations across language stacks (e.g., C++ to Rust, JS to Go). Preserves logic equivalence while optimizing for the target language's idioms. | `npm run cli -- execute technology-porter` |
| **telemetry-insight-engine** | Analyzes real-world telemetry and usage data to identify feature gaps and usability issues. Feeds insights back into the requirements phase. | `npm run cli -- execute telemetry-insight-engine` |
| **template-renderer** | Render text from templates (Mustache/EJS) and data. | `npm run cli -- execute template-renderer` |
| **terraform-arch-mapper** | Generates a system architecture diagram from Terraform code. It parses .tf files to identify resources and relationships, then produces a diagram code (Mermaid/PlantUML). Use to visualize infrastructure. | `npm run cli -- execute terraform-arch-mapper` |
| **test-genie** | Executes the project's test suite and returns the output for AI analysis. | `npm run cli -- execute test-genie` |
| **test-suite-architect** | Generates comprehensive test code (Jest, Pytest, Cypress) from requirements and test viewpoints. Enables Test-Driven Development (TDD) at scale. | `npm run cli -- execute test-suite-architect` |
| **test-viewpoint-analyst** | Generates and reviews test scenarios based on IPA non-functional grade standards. Analyzes system requirements to identify critical test viewpoints for performance, security, and availability. | `npm run cli -- execute test-viewpoint-analyst` |
| **asset-token-economist** | Minimizes token consumption and costs by optimizing data input. Performs smart summarization and chunking of large files without losing critical context. | `npm run cli -- execute asset-token-economist` |
| **unit-economics-optimizer** | Analyzes LTV, CAC, and churn to ensure product profitability. Proposes pricing and customer retention strategies to maximize unit margins. | `npm run cli -- execute unit-economics-optimizer` |
| **ux-auditor** | Performs visual and structural UX/Accessibility audits on web interfaces. Analyzes screenshots to recommend improvements for usability and contrast. | `npm run cli -- execute ux-auditor` |
| **visionary-ethos-keeper** | Ensures decisions and proposals align with company mission, values, and ethical guidelines. Checks for bias, privacy, and fairness concerns. | `npm run cli -- execute visionary-ethos-keeper` |
| **voice-command-listener** | Captures microphone input and transcribes it into text commands. Uses SoX for recording and OpenAI Whisper for high-accuracy transcription to control the agent via voice. | `npm run cli -- execute voice-command-listener` |
| **voice-interface-maestro** | Converts text responses into spoken audio (TTS). Supports multiple voice personas (Professional, Energetic, Calm) and secure configuration via the Personal Tier. | `npm run cli -- execute voice-interface-maestro` |
| **word-artisan** | Generate Word documents (.docx) from Markdown. | `npm run cli -- execute word-artisan` |

---
*Generated by Ecosystem Architect Tool*