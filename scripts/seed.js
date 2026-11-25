require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');

const ORDERS_PER_TENANT = Number(process.env.SEED_ORDERS_PER_TENANT || 50000);
const BATCH = 1000;

const TENANTS = [
  {
    slug: 'acme', name: 'Acme Traders', email: 'admin@acme.com', password: 'Acme@123',
    products: [['Steel Bolt Pack', 4.5], ['Copper Wire 10m', 12], ['Safety Gloves', 6.75], ['Power Drill', 89.99],
               ['Paint Bucket 5L', 24.5], ['Measuring Tape', 5.25], ['Hard Hat', 15], ['Work Boots', 54.9]],
  },
  {
    slug: 'globex', name: 'Globex Pharma', email: 'admin@globex.com', password: 'Globex@123',
    products: [['Paracetamol Box', 3.2], ['Vitamin C Strip', 7.8], ['Digital Thermometer', 11.5], ['Face Mask Pack', 4.1],
               ['Hand Sanitizer 500ml', 5.9], ['BP Monitor', 49], ['First Aid Kit', 22], ['Glucose Meter', 35.5]],
  },
];

const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

(async () => {
  const reset = process.argv.includes('--reset');
  const [existing] = await pool.query('SELECT COUNT(*) AS c FROM tenants');
  if (existing[0].c > 0 && !reset) {
    console.log('Database already seeded. Run "npm run seed:reset" to wipe and seed again.');
    return pool.end();
  }

  if (reset) {
    const conn = await pool.getConnection();
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['invoice_log', 'processed_events', 'order_items', 'orders', 'products', 'users', 'tenants']) {
      await conn.query(`TRUNCATE TABLE ${t}`);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    conn.release();
    console.log('Old data wiped.');
  }

  let nextOrderId = 1;
  for (const t of TENANTS) {
    const [tr] = await pool.query('INSERT INTO tenants (slug, name) VALUES (?, ?)', [t.slug, t.name]);
    const tenantId = tr.insertId;
    await pool.query('INSERT INTO users (tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [tenantId, t.email, await bcrypt.hash(t.password, 10), 'admin']);
    await pool.query('INSERT INTO products (tenant_id, name, price, stock) VALUES ?',
      [t.products.map(([n, p]) => [tenantId, n, p, 100000])]);
    const [products] = await pool.query('SELECT id, price FROM products WHERE tenant_id = ?', [tenantId]);

    console.log(`Seeding ${ORDERS_PER_TENANT} orders for ${t.slug}...`);
    for (let done = 0; done < ORDERS_PER_TENANT; done += BATCH) {
      const orderRows = [];
      const itemRows = [];
      const n = Math.min(BATCH, ORDERS_PER_TENANT - done);
      for (let k = 0; k < n; k++) {
        const id = nextOrderId++;
        let total = 0;
        const lines = rand(1, 4);
        for (let l = 0; l < lines; l++) {
          const p = products[rand(0, products.length - 1)];
          const qty = rand(1, 10);
          total += p.price * qty;
          itemRows.push([id, tenantId, p.id, qty, p.price]);
        }
        const createdAt = new Date(Date.now() - Math.random() * 365 * 24 * 3600 * 1000);
        orderRows.push([id, tenantId, 'COMPLETED', Math.round(total * 100) / 100, createdAt]);
      }
      await pool.query('INSERT INTO orders (id, tenant_id, status, total, created_at) VALUES ?', [orderRows]);
      await pool.query('INSERT INTO order_items (order_id, tenant_id, product_id, quantity, unit_price) VALUES ?', [itemRows]);
      if ((done + n) % 10000 === 0 || done + n === ORDERS_PER_TENANT) console.log(`  ${t.slug}: ${done + n} orders`);
    }
  }

  console.log('\nSeed finished. Test accounts:');
  for (const t of TENANTS) console.log(`  ${t.slug.padEnd(7)} -> ${t.email} / ${t.password}   (x-tenant-id: ${t.slug})`);
  await pool.end();
})().catch((e) => {
  console.error('Seed failed:', e.message);
  process.exit(1);
});
