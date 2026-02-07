# 詳細設計書：在庫管理ロジック

## 1. クラス定義 `InventoryManager`
- `updateStock(current, change)`:
    - 戻り値: `newStock` or `error`
    - 条件: `current + change >= 0`
- `checkAlert(stock, threshold)`:
    - 戻り値: `boolean` (True if `stock <= threshold`)
