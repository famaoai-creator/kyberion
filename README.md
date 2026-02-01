# Gemini Skills Monorepo

This repository contains a collection of specialized skills for the **Gemini CLI**. These skills extend the agent's capabilities to automate software engineering tasks and document analysis.

## 🛠 Skills in this Repository

### 1. [GitHub Skills Manager](./github-skills-manager/)
An interactive TUI dashboard to manage the lifecycle of Gemini skills.
- **Features:** Create, install, sync, and delete skills from local or remote repositories.
- **How to use:**
  ```bash
  node github-skills-manager/scripts/dashboard.cjs
  ```

### 2. [Doc-to-Text](./doc-to-text/)
A powerful text extraction engine that supports various file formats, including OCR for embedded images.
- **Capabilities:**
  - **Office Documents:** Word (`.docx`), Excel (`.xlsx`), PowerPoint (`.pptx`) - *Includes OCR for embedded images.*
  - **PDF:** Plain text extraction.
  - **Images:** OCR for `.png`, `.jpg`, `.webp`, etc. (Supports English & Japanese).
  - **Archives:** Text extraction from `.zip` files.
  - **Emails:** Parsing `.eml` files.
- **How to use:**
  ```bash
  node doc-to-text/scripts/extract.cjs <path_to_file>
  ```

### 3. [Codebase Mapper](./codebase-mapper/)
Maps the directory structure of the project to help the AI understand the codebase layout.
- **How to use:**
  ```bash
  node codebase-mapper/scripts/map.cjs <directory_path> [max_depth]
  ```

### 4. [Local Reviewer](./local-reviewer/)
Retrieves the `git diff` of staged files to allow the AI to perform a code review before committing.
- **How to use:**
  ```bash
  node local-reviewer/scripts/review.cjs
  ```

### 5. [Log Analyst](./log-analyst/)
Reads the tail (end) of a log file to help analyze recent errors or runtime behavior.
- **How to use:**
  ```bash
  node log-analyst/scripts/tail.cjs <path_to_log_file> [num_lines]
  ```

### 6. [PowerPoint Artisan](./ppt-artisan/)
Create and convert PowerPoint presentations from Markdown using Marp.
- **How to use:**
  ```bash
  node ppt-artisan/scripts/convert.cjs <input_file.md> [pptx|pdf]
  ```

### 7. [Schema Inspector](./schema-inspector/)
Automatically locates and displays the content of schema definition files (SQL, Prisma, OpenAPI, etc.).
- **How to use:**
  ```bash
  node schema-inspector/scripts/inspect.cjs <project_root>
  ```

### 8. [Test Genie](./test-genie/)
Executes the project's test suite and returns the output. It attempts to auto-detect the test command.
- **How to use:**
  ```bash
  node test-genie/scripts/run.cjs <project_root> [custom_command]
  ```

## 🚀 Installation

To install these skills into your Gemini CLI workspace:

1. Clone this repository:
   ```bash
   git clone https://github.com/famaoai-creator/gemini-skills.git
   cd gemini-skills
   ```

2. Install dependencies for the skills (if required):
   ```bash
   cd doc-to-text && npm install && cd ..
   ```

3. Install the skills into Gemini CLI:
   ```bash
   gemini skills install <skill-directory-name> --scope workspace
   ```

## 📂 Project Structure

```text
.
├── codebase-mapper/        # Map project directory structure
├── doc-to-text/            # Document extraction and OCR skill
├── github-skills-manager/  # TUI for skill management
├── local-reviewer/         # Git diff code reviewer
├── log-analyst/            # Log file tail analysis
├── ppt-artisan/            # Markdown to PowerPoint/PDF
├── schema-inspector/       # Schema file discovery and inspection
├── test-genie/             # Test suite execution and analysis
└── README.md               # You are here
```

## 📝 Development

- **Language:** Node.js (v25.5.0+)
- **License:** MIT