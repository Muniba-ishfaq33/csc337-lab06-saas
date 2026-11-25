const pool = require('./config/db');

const ORDERS_SQL =
  'SELECT id, status, total, created_at FROM orders WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?';

/**
 * TENANT DATA BOUNDARY
 * Routes never touch the database directly. They call forTenant(tenantId) and get an object
 * whose every query is hard-wired with "tenant_id = ?". A route cannot forget the filter,
 * because the filter is written once, here.
 */
function forTenant(tenantId) {
  if (!Number.isInteger(tenantId)) throw new Error('Tenant context missing - refusing to query');
  const t = tenantId;

  return {
    tenantId: t,

    // ---------- users ----------
    async findUserByEmail(email) {
      const [rows] = await pool.query(
        'SELECT id, email, password_hash, role FROM users WHERE tenant_id = ? AND email = ?',
        [t, email]
      );
      return rows[0] || null;
    },

    // ---------- products ----------
    async listProducts() {
      const [rows] = await pool.query(
        'SELECT id, name, price, stock FROM products WHERE tenant_id = ? ORDER BY id',
        [t]
      );
      return rows;
    },

    async getProductsByIds(ids) {
      if (!ids.length) return [];
      const [rows] = await pool.query(
        'SELECT id, name, price, stock FROM products WHERE tenant_id = ? AND id IN (?)',
        [t, ids]
      );
      return rows;
    },

    // ---------- orders ----------
    async createOrder(items) {
      const total = Math.round(items.reduce((s, i) => s + i.unit_price * i.quantity, 0) * 100) / 100;
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [res] = await conn.query(
          'INSERT INTO orders (tenant_id, status, total) VALUES (?, ?, ?)',
          [t, 'PENDING', total]
        );
        const orderId = res.insertId;
        const rows = items.map((i) => [orderId, t, i.product_id, i.quantity, i.unit_price]);
        await conn.query(
          'INSERT INTO order_items (order_id, tenant_id, product_id, quantity, unit_price) VALUES ?',
          [rows]
        );
        await conn.commit();
        return { id: orderId, total };
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    },

    async setOrderStatus(orderId, status) {
      await pool.query('UPDATE orders SET status = ? WHERE id = ? AND tenant_id = ?', [status, orderId, t]);
    },

    async getOrder(orderId) {
      const [orders] = await pool.query(
        'SELECT id, status, total, created_at FROM orders WHERE id = ? AND tenant_id = ?',
        [orderId, t]
      );
      if (!orders[0]) return null; // another tenant's order looks exactly like "does not exist"
      const [items] = await pool.query(
        `SELECT i.product_id, p.name, i.quantity, i.unit_price
           FROM order_items i
           JOIN products p ON p.id = i.product_id AND p.tenant_id = i.tenant_id
          WHERE i.order_id = ? AND i.tenant_id = ?`,
        [orderId, t]
      );
      return { ...orders[0], items };
    },

    // ---------- N+1 DEMO ----------
    // BAD: 1 query for the orders, then 1 more query PER order for its items = N+1 queries.
    async ordersWithItemsNPlusOne(limit = 100) {
      const start = process.hrtime.bigint();
      let queries = 0;
      const [orders] = await pool.query(ORDERS_SQL, [t, limit]);
      queries++;
      for (const o of orders) {
        const [items] = await pool.query(
          'SELECT product_id, quantity, unit_price FROM order_items WHERE order_id = ? AND tenant_id = ?',
          [o.id, t]
        );
        queries++;
        o.items = items;
      }
      return { strategy: 'N+1 (one query per order)', queries, rows: orders.length, ms: elapsed(start), orders };
    },

    // GOOD: one single JOIN query, then we group the rows in JavaScript.
    async ordersWithItemsJoin(limit = 100) {
      const start = process.hrtime.bigint();
      const [rows] = await pool.query(
        `SELECT o.id, o.status, o.total, o.created_at, i.product_id, i.quantity, i.unit_price
           FROM (SELECT id, status, total, created_at
                   FROM orders WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?) o
           LEFT JOIN order_items i ON i.order_id = o.id AND i.tenant_id = ?
          ORDER BY o.created_at DESC, o.id DESC`,
        [t, limit, t]
      );
      const map = new Map();
      for (const r of rows) {
        if (!map.has(r.id)) {
          map.set(r.id, { id: r.id, status: r.status, total: r.total, created_at: r.created_at, items: [] });
        }
        if (r.product_id !== null) {
          map.get(r.id).items.push({ product_id: r.product_id, quantity: r.quantity, unit_price: r.unit_price });
        }
      }
      const orders = [...map.values()];
      return { strategy: 'JOIN (single query)', queries: 1, rows: orders.length, ms: elapsed(start), orders };
    },

    async explainOrders() {
      const [rows] = await pool.query('EXPLAIN ANALYZE ' + ORDERS_SQL, [t, 50]);
      return rows.map((r) => Object.values(r)[0]).join('\n');
    },

    // ---------- consumer side ----------
    // Subtract stock and mark the order COMPLETED, all in one transaction.
    async fulfillOrder(orderId) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [ord] = await conn.query(
          'SELECT status FROM orders WHERE id = ? AND tenant_id = ? FOR UPDATE',
          [orderId, t]
        );
        if (!ord[0]) {
          await conn.rollback();
          return { ok: false, outcome: 'SKIPPED: order not found for this tenant' };
        }
        if (ord[0].status !== 'PENDING') {
          await conn.rollback();
          return { ok: true, outcome: `SKIPPED: already ${ord[0].status}` };
        }
        const [items] = await conn.query(
          'SELECT product_id, quantity FROM order_items WHERE order_id = ? AND tenant_id = ?',
          [orderId, t]
        );
        items.sort((a, b) => a.product_id - b.product_id); // same lock order = fewer deadlocks
        for (const it of items) {
          const [r] = await conn.query(
            'UPDATE products SET stock = stock - ? WHERE id = ? AND tenant_id = ? AND stock >= ?',
            [it.quantity, it.product_id, t, it.quantity]
          );
          if (r.affectedRows === 0) {
            await conn.rollback();
            await pool.query('UPDATE orders SET status = ? WHERE id = ? AND tenant_id = ?', ['FAILED', orderId, t]);
            return { ok: false, outcome: `FAILED: not enough stock for product ${it.product_id}` };
          }
        }
        await conn.query('UPDATE orders SET status = ? WHERE id = ? AND tenant_id = ?', ['COMPLETED', orderId, t]);
        await conn.commit();
        return { ok: true, outcome: 'COMPLETED' };
      } catch (err) {
        try { await conn.rollback(); } catch (_) { /* ignore */ }
        throw err;
      } finally {
        conn.release();
      }
    },

    async wasEventProcessed(eventId) {
      const [rows] = await pool.query(
        'SELECT 1 FROM processed_events WHERE event_id = ? AND tenant_id = ?',
        [eventId, t]
      );
      return rows.length > 0;
    },

    async logProcessedEvent(e) {
      await pool.query(
        `INSERT IGNORE INTO processed_events
           (event_id, tenant_id, order_id, topic, kafka_partition, kafka_offset, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [e.event_id, t, e.order_id, e.topic, e.partition, String(e.offset), e.outcome]
      );
    },

    async logInvoice(orderId, coldStart, functionMs, roundtripMs) {
      await pool.query(
        'INSERT INTO invoice_log (tenant_id, order_id, cold_start, function_ms, roundtrip_ms) VALUES (?, ?, ?, ?, ?)',
        [t, orderId, coldStart ? 1 : 0, functionMs, roundtripMs]
      );
    },

    // ---------- dashboard helpers ----------
    async recentEvents(limit = 15) {
      const [rows] = await pool.query(
        `SELECT order_id, kafka_partition, kafka_offset, outcome, processed_at
           FROM processed_events WHERE tenant_id = ? ORDER BY id DESC LIMIT ?`,
        [t, limit]
      );
      return rows;
    },

    async invoiceStats() {
      const [rows] = await pool.query(
        `SELECT IF(cold_start = 1, 'cold', 'warm') AS start_type, COUNT(*) AS calls,
                ROUND(AVG(function_ms), 1) AS avg_function_ms,
                ROUND(AVG(roundtrip_ms), 1) AS avg_roundtrip_ms
           FROM invoice_log WHERE tenant_id = ? GROUP BY cold_start`,
        [t]
      );
      return rows;
    },
  };
}

function elapsed(start) {
  return Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 100) / 100;
}

module.exports = { forTenant };
