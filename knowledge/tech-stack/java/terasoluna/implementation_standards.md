# TERASOLUNA Implementation Standards

エンタープライズ品質を確保するための実装ルール。

## 1. 主要技術スタック
- **Framework**: Spring Framework / Spring Boot
- **Web**: Spring MVC
- **Security**: Spring Security
- **Data Access**: MyBatis3 (または JPA)
- **Validation**: Bean Validation (Hibernate Validator)

## 2. 実装の要諦 (Best Practices)
- **バリデーション**:
    - 単項目チェック: `Form` クラスでのアノテーションによる宣言的定義。
    - 相関チェック: `Validator` 実装、または `Service` 層でのビジネスチェック。
- **例外ハンドリング**:
    - `ControllerAdvice` による集約例外処理。
    - 業務例外（BusinessException）とシステム例外（SystemException）を明確に区別する。
- **トランザクション管理**:
    - `Service` クラスのメソッド単位で `@Transactional` を付与。
    - 参照系と更新系で適切に読込専用（readOnly）フラグを使い分ける。

## 3. セキュリティ
- **認証・認可**: Spring Security を活用し、URL単位のアクセス制御を行う。
- **対策**: CSRF対策、セキュリティヘッダー付与、入力値サニタイズの標準適用。

---
*Created: 2026-02-14 | Ecosystem Architect*
