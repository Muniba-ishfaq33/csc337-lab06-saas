# Benchmark Results

Generated: 2026-11-25T05:13:42.990Z
Database: MySQL 8.0.30 | Tenant: `acme` | Rows in orders for this tenant: **50002**

## 1. Query: latest 50 orders for a tenant

```sql
SELECT id, status, total, created_at FROM orders WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50
```

### EXPLAIN ANALYZE - BEFORE composite index
```
-> Limit: 50 row(s)  (cost=5089.55 rows=50) (actual time=164.233..164.248 rows=50 loops=1)
    -> Sort: orders.created_at DESC, limit input to 50 row(s) per chunk  (cost=5089.55 rows=48728) (actual time=164.232..164.240 rows=50 loops=1)
        -> Index lookup on orders using fk_orders_tenant (tenant_id=1)  (actual time=0.090..151.441 rows=50002 loops=1)

```

### EXPLAIN ANALYZE - AFTER `CREATE INDEX idx_orders_tenant_created ON orders (tenant_id, created_at)`
```
-> Limit: 50 row(s)  (cost=5089.55 rows=50) (actual time=0.603..0.618 rows=50 loops=1)
    -> Index lookup on orders using idx_orders_tenant_created (tenant_id=1; iterate backwards)  (cost=5089.55 rows=48728) (actual time=0.602..0.611 rows=50 loops=1)

```

| | Before index | After index |
|---|---|---|
| EXPLAIN ANALYZE top-level actual time (ms) | 164.248 | 0.618 |
| Avg latency over 15 runs (ms) | 162.19 | 0.9 |
| Median (ms) | 159.76 | 0.86 |
| Min / Max (ms) | 149.92 / 185.43 | 0.71 / 1.14 |

## 2. N+1 problem vs single JOIN (100 orders with their items, 5 runs each)

| Strategy | SQL queries | Avg time (ms) |
|---|---|---|
| N+1 (one query per order) | 101 | 67.93 |
| JOIN (single query) | 1 | 4.67 |
