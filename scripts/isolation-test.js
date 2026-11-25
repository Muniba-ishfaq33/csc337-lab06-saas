// Proves Tenant A can never see Tenant B's data. Start the API first (npm start).
const BASE = process.env.BASE_URL || 'http://localhost:3000';
let failed = 0;

async function call(method, path, { token, tenant, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  const r = await fetch(BASE + '/api/v1' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`);
  if (!ok) failed++;
}

(async () => {
  const a = await call('POST', '/auth/login', { tenant: 'acme', body: { email: 'admin@acme.com', password: 'Acme@123' } });
  const b = await call('POST', '/auth/login', { tenant: 'globex', body: { email: 'admin@globex.com', password: 'Globex@123' } });
  check('Tenant A can log in', a.status === 200);
  check('Tenant B can log in', b.status === 200);
  const tokenA = a.data.token, tokenB = b.data.token;

  const wrongTenant = await call('POST', '/auth/login', { tenant: 'globex', body: { email: 'admin@acme.com', password: 'Acme@123' } });
  check("A's credentials do not work on tenant B", wrongTenant.status === 401, `(got ${wrongTenant.status})`);

  const ordersA = (await call('GET', '/orders?limit=50', { token: tokenA })).data.orders || [];
  const ordersB = (await call('GET', '/orders?limit=50', { token: tokenB })).data.orders || [];
  const idsA = new Set(ordersA.map((o) => o.id));
  check('Order lists of A and B do not overlap', ordersA.length > 0 && ordersB.length > 0 && !ordersB.some((o) => idsA.has(o.id)));

  const steal = await call('GET', `/orders/${ordersA[0].id}`, { token: tokenB });
  check("B cannot read A's order by id (expects 404)", steal.status === 404, `(got ${steal.status})`);

  const spoof = await call('GET', '/orders', { token: tokenA, tenant: 'globex' });
  check("A's token + header x-tenant-id: globex is rejected (expects 403)", spoof.status === 403, `(got ${spoof.status})`);

  const productsA = (await call('GET', '/products', { token: tokenA })).data;
  const cross = await call('POST', '/orders', { token: tokenB, body: { items: [{ product_id: productsA[0].id, quantity: 1 }] } });
  check("B cannot order A's product (expects 400)", cross.status === 400, `(got ${cross.status})`);

  const anon = await call('GET', '/orders');
  check('No token and no tenant is rejected', anon.status === 400 || anon.status === 401, `(got ${anon.status})`);

  console.log(failed === 0 ? '\nAll isolation checks passed.' : `\n${failed} check(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('Could not run test (is the API running?):', e.message);
  process.exit(1);
});
