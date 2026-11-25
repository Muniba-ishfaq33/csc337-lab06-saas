// Runs the full "before vs after" experiment and writes BENCHMARK_RESULTS.md
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');
const { forTenant } = require('../src/repo');

const INDEX = 'idx_orders_tenant_created';
const SQL = 'SELECT id, status, total, created_at FROM orders WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50';

async function hasIndex() {
  const [r] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'orders' AND index_name = ?`, [INDEX]);
  return r[0].c > 0;
}
async function explain(tenantId) {
  const [rows] = await pool.query('EXPLAIN ANALYZE ' + SQL, [tenantId]);
  return rows.map((r) => Object.values(r)[0]).join('\n');
}
async function timeQuery(tenantId, runs = 15) {
  await pool.query(SQL, [tenantId]); // warm-up
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    await pool.query(SQL, [tenantId]);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((s, x) => s + x, 0) / times.length;
  return { avg: +avg.toFixed(2), median: +times[Math.floor(times.length / 2)].toFixed(2), min: +times[0].toFixed(2), max: +times[times.length - 1].toFixed(2) };
}
const topActual = (plan) => {
  const m = plan.match(/actual time=([\d.]+)\.\.([\d.]+)/);
  return m ? +m[2] : null;
};

(async () => {
  const [[tenant]] = await pool.query("SELECT id, slug FROM tenants WHERE slug = 'acme'");
  if (!tenant) throw new Error('Run "npm run seed" first.');
  const [[cnt]] = await pool.query('SELECT COUNT(*) AS c FROM orders WHERE tenant_id = ?', [tenant.id]);
  const [[ver]] = await pool.query('SELECT VERSION() AS v');
  console.log(`MySQL ${ver.v}, tenant ${tenant.slug} has ${cnt.c} orders\n`);

  // ---- 1. EXPLAIN ANALYZE before / after composite index ----
  if (await hasIndex()) await pool.query(`ALTER TABLE orders DROP INDEX ${INDEX}`);
  const planBefore = await explain(tenant.id);
  const timeBefore = await timeQuery(tenant.id);

  await pool.query(`CREATE INDEX ${INDEX} ON orders (tenant_id, created_at)`);
  const planAfter = await explain(tenant.id);
  const timeAfter = await timeQuery(tenant.id);

  // ---- 2. N+1 vs JOIN ----
  const db = forTenant(tenant.id);
  await db.ordersWithItemsJoin(10);
  const runs = 5;
  const nPlus = [], join = [];
  let nq = 0;
  for (let i = 0; i < runs; i++) {
    const a = await db.ordersWithItemsNPlusOne(100); nPlus.push(a.ms); nq = a.queries;
    const b = await db.ordersWithItemsJoin(100); join.push(b.ms);
  }
  const avg = (a) => +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2);

  const md = `# Benchmark Results

Generated: ${new Date().toISOString()}
Database: MySQL ${ver.v} | Tenant: \`${tenant.slug}\` | Rows in orders for this tenant: **${cnt.c}**

## 1. Query: latest 50 orders for a tenant

\`\`\`sql
${SQL}
\`\`\`

### EXPLAIN ANALYZE - BEFORE composite index
\`\`\`
${planBefore}
\`\`\`

### EXPLAIN ANALYZE - AFTER \`CREATE INDEX ${INDEX} ON orders (tenant_id, created_at)\`
\`\`\`
${planAfter}
\`\`\`

| | Before index | After index |
|---|---|---|
| EXPLAIN ANALYZE top-level actual time (ms) | ${topActual(planBefore)} | ${topActual(planAfter)} |
| Avg latency over 15 runs (ms) | ${timeBefore.avg} | ${timeAfter.avg} |
| Median (ms) | ${timeBefore.median} | ${timeAfter.median} |
| Min / Max (ms) | ${timeBefore.min} / ${timeBefore.max} | ${timeAfter.min} / ${timeAfter.max} |

## 2. N+1 problem vs single JOIN (100 orders with their items, ${runs} runs each)

| Strategy | SQL queries | Avg time (ms) |
|---|---|---|
| N+1 (one query per order) | ${nq} | ${avg(nPlus)} |
| JOIN (single query) | 1 | ${avg(join)} |
`;
  fs.writeFileSync(path.join(__dirname, '..', 'BENCHMARK_RESULTS.md'), md);
  console.log(md);
  console.log('Saved to BENCHMARK_RESULTS.md. The composite index is now ACTIVE.');
  await pool.end();
})().catch((e) => {
  console.error('Benchmark failed:', e.message);
  process.exit(1);
});
