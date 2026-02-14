# The Rosetta Stone of Cloud (Multi-Cloud Mapping)

クラウドベンダー間のサービス対応表と、設計思想の相違点。

## 1. サービス対応マトリクス

| カテゴリ | AWS | Google Cloud | Azure |
| :--- | :--- | :--- | :--- |
| **Compute (Function)** | Lambda | Cloud Functions / Run | Azure Functions |
| **Compute (Container)** | ECS / Fargate | Cloud Run / GKE | Container Apps / AKS |
| **Object Storage** | S3 | Cloud Storage (GCS) | Blob Storage |
| **Database (NoSQL)** | DynamoDB | Firestore / Bigtable | Cosmos DB |
| **Database (SQL)** | RDS / Aurora | Cloud SQL / Spanner | SQL Database |
| **API Gateway** | API Gateway | Cloud Endpoints / Apigee | API Management |
| **Auth / Identity** | IAM / Cognito | Cloud IAM / Identity Platform | Entra ID (Azure AD) |

## 2. 設計思想の落とし穴 (Architect's Note)
- **AWS**: 「堅牢性と細粒度な制御」。IAM ポリシーが複雑になりがちだが、非常に強力な制限が可能。
- **GCP**: 「開発効率とデータ統合」。プロジェクト単位の管理が直感的で、BigQuery などのデータ分析系との親和性が極めて高い。
- **Azure**: 「エンタープライズ親和性」。AD (Entra ID) 連携が前提の組織において最強。Office 365 資産との統合が鍵。

---
*Created: 2026-02-14 | Infinite Librarian*
