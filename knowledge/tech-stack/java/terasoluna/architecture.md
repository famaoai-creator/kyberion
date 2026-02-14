# TERASOLUNA Layered Architecture Standard

NTTデータが推奨する、堅牢なエンタープライズJavaアプリケーションのためのレイヤ構造。

## 1. 3層 + 1レイヤ構造

### A. Application Layer (アプリケーション層)
- **役割**: 利用者との入出力を制御し、ドメイン層のサービスを呼び出す。
- **主要コンポーネント**: 
    - **Controller**: リクエストの受付、入力チェック（単項目）、画面遷移制御。
    - **Form**: 画面入力値の保持。
    - **View**: 出力（HTML, JSON等）の生成。

### B. Domain Layer (ドメイン層)
- **役割**: ビジネスロジックの中核。アプリケーションの本質的なルールを記述する。
- **主要コンポーネント**:
    - **Service**: ビジネスロジックの実行。トランザクションの境界となる。
    - **Domain Object (Entity)**: 業務データとそれに関連する振る舞い。
    - **Repository Interface**: 永続化操作の抽象化。

### C. Infrastructure Layer (インフラストラクチャ層)
- **役割**: ドメイン層（Repository Interface）の具体的な実装。DBアクセスや外部システム連携。
- **主要コンポーネント**:
    - **Repository Implementation**: MyBatis 等を用いたデータアクセス。
    - **O/R Mapper**: MyBatis3, JPA。

### D. Shared Layer (共通層)
- 全てのレイヤから参照可能な共通ライブラリやユーティリティ。

## 2. データフローとオブジェクト
- **入出力**: 画面からの入力は `Form` で受け取り、ドメイン層へ渡す際に `Entity` や `DTO` へ変換する。
- **依存関係**: 上位レイヤから下位レイヤへの一方向依存を徹底する（Application -> Domain -> Infrastructure）。

---
*Reference: [TERASOLUNA Application Layering](https://terasolunaorg.github.io/guideline/current/ja/Overview/ApplicationLayering.html)*
