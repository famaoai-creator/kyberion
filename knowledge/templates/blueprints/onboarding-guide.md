# Blueprint: Onboarding Guide
<!-- Visibility: [L2: MANAGEMENT, L3: SYSTEM/DATA] -->

## 1. Welcome & Vision [L1]
- **Project Ethos**: AIによる定型業務の完全自動化と、人間への「自由」の提供。
- **Key Success Drivers**: スピードよりもガバナンスと物理的証拠（Evidence）の整合性を重視。

## 2. Prerequisites & Setup [L2]
### **System Requirements**
- Node.js v20+, pnpm v10+
- **Visual Engines (Required for diagram-renderer)**:
    ```bash
    # Install via Homebrew (macOS)
    brew install d2 plantuml
    ```

### **Initial Bootstrap**
```bash
# Setup ecosystem and internal links
node scripts/bootstrap.cjs
pnpm install
```

## 3. Quick Start for AI Agents [L3] [INVENTORY: Skills]
- **3.1 Core Protocol**: `gemini-diagram-v1.1` (Intent x Engine mapping)
- **3.2 Development Policy (Section M)**:
    - **Secure IO**: `fs`モジュールの直接使用は禁止。必ず `@agent/core/secure-io` を使用せよ。
    - **Legacy Preservation**: ファイル上書き前に既存メソッドのインベントリを必ず取ること。
- **3.3 Access Tiers**: Personal / Confidential / Public の境界を意識せよ。

## 4. Resource Directory [L3]
- **Knowledge Base**: `knowledge/` 配下の 48 カテゴリを参照。
- **Blueprints**: `knowledge/templates/blueprints/` に定義された 26 種類の設計図を遵守せよ。
- **Vault Access**: `vault/` へのアクセスは主権者の承認（Sudo Gate）を基本とする。
