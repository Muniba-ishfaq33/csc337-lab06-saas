const crypto = require('crypto');
const express = require('express');
const pool = require('../config/db');
const { wrap } = require('../utils');
const { requireAdmin } = require('../middleware/tenant');
const { publishOrderCreated } = require('../producer');

const router = express.Router();
const INDEX_NAME = 'idx_orders_tenant_created';

// ---------------------------------------------------------------- products
router.get('/products', wrap(async (req, res) => {
  res.json(await req.db.listProducts());
}));

// ---------------------------------------------------------------- orders
// Optimised list: orders + items in ONE join query.
router.get('/orders', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
  const result = await req.db.ordersWithItemsJoin(limit);
  res.json({ tenant: req.tenant.slug, count: result.rows, orders: result.orders });
}));

router.get('/orders/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad order id' });
  const order = await req.db.getOrder(id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
}));

// Place an order: save as PENDING, publish OrderCreated to Kafka, reply 202 straight away.
router.post('/orders', wrap(async (req, res) => {
  const raw = req.body && req.body.items;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) {
    return res.status(400).json({ error: 'items must be an array of 1-20 entries' });
  }

  // merge duplicate products and validate numbers
  const wanted = new Map();
  for (const it of raw) {
    const pid = Number(it.product_id);
    const qty = Number(it.quantity);
    if (!Number.isInteger(pid) || !Number.isInteger(qty) || qty < 1 || qty > 100000) {
      return res.status(400).json({ error: 'Each item needs integer product_id and quantity >= 1' });
    }
    wanted.set(pid, (wanted.get(pid) || 0) + qty);
  }

  // products are looked up INSIDE this tenant only - another tenant's product id simply "does not exist"
  const products = await req.db.getProductsByIds([...wanted.keys()]);
  if (products.length !== wanted.size) {
    return res.status(400).json({ error: 'One or more products do not exist in your tenant' });
  }
  const items = products.map((p) => ({ product_id: p.id, quantity: wanted.get(p.id), unit_price: p.price }));

  const order = await req.db.createOrder(items);

  const event = {
    event_id: crypto.randomUUID(),
    type: 'OrderCreated',
    tenant_id: req.tenant.id,
    tenant_slug: req.tenant.slug,
    order_id: order.id,
    total: order.total,
    created_at: new Date().toISOString(),
  };

  try {
    const meta = await publishOrderCreated(event);
    res.status(202).json({
      message: 'Order accepted and queued for processing',
      order_id: order.id,
      status: 'PENDING',
      event_id: event.event_id,
      kafka: meta,
    });
  } catch (err) {
    await req.db.setOrderStatus(order.id, 'FAILED');
    console.error('[kafka] publish failed:', err.message);
    res.status(503).json({ error: 'Message broker unavailable, order marked FAILED', order_id: order.id });
  }
}));

// ---------------------------------------------------------------- dashboard helpers
router.get('/events', wrap(async (req, res) => {
  res.json(await req.db.recentEvents());
}));

router.get('/invoices/stats', wrap(async (req, res) => {
  res.json(await req.db.invoiceStats());
}));

// ---------------------------------------------------------------- benchmark (for the viva)
// N+1 vs JOIN, same data, same tenant
router.get('/benchmark/compare', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  await req.db.ordersWithItemsJoin(5); // warm-up so the first call is not unfairly slow
  const bad = await req.db.ordersWithItemsNPlusOne(limit);
  const good = await req.db.ordersWithItemsJoin(limit);
  const strip = ({ orders, ...rest }) => rest;
  res.json({
    limit,
    n_plus_one: strip(bad),
    join: strip(good),
    speedup: good.ms > 0 ? `${(bad.ms / good.ms).toFixed(1)}x faster with JOIN` : 'n/a',
  });
}));

async function indexExists() {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'orders' AND index_name = ?`,
    [INDEX_NAME]
  );
  return rows[0].c > 0;
}

router.get('/benchmark/explain', wrap(async (req, res) => {
  const t0 = process.hrtime.bigint();
  const plan = await req.db.explainOrders();
  res.json({
    index_present: await indexExists(),
    index_name: INDEX_NAME,
    query: 'SELECT id, status, total, created_at FROM orders WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50',
    plan,
    round_trip_ms: Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 100) / 100,
  });
}));

// Drop / create the composite index live (admin only) so you can show BEFORE and AFTER to the instructor
router.post('/benchmark/index', requireAdmin, wrap(async (req, res) => {
  if (process.env.ALLOW_BENCHMARK_DDL === 'false') return res.status(403).json({ error: 'Disabled' });
  const action = req.body && req.body.action;
  const exists = await indexExists();
  if (action === 'drop' && exists) await pool.query(`ALTER TABLE orders DROP INDEX ${INDEX_NAME}`);
  else if (action === 'create' && !exists) await pool.query(`CREATE INDEX ${INDEX_NAME} ON orders (tenant_id, created_at)`);
  else if (action !== 'drop' && action !== 'create') return res.status(400).json({ error: 'action must be drop or create' });
  res.json({ index_present: await indexExists(), index_name: INDEX_NAME });
}));

module.exports = router;
