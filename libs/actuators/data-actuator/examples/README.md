# data-actuator examples

Offline tabular ops over local `.json` / `.csv` files. No network.

## Query with filter, projection, sort, limit

```json
{
  "op": "query",
  "params": {
    "file": "active/shared/staging/orders.json",
    "where": { "status": "active" },
    "select": ["id", "status"],
    "sort_by": "id",
    "limit": 10
  }
}
```

## Aggregate: count rows per group

```json
{
  "op": "aggregate",
  "params": {
    "file": "active/shared/staging/orders.json",
    "group_by": "status",
    "aggregations": [{ "func": "count", "as": "n" }]
  }
}
```

Sum example:

```json
{
  "op": "aggregate",
  "params": {
    "file": "active/shared/staging/orders.json",
    "group_by": "status",
    "aggregations": [{ "func": "sum", "field": "amount", "as": "total" }]
  }
}
```
