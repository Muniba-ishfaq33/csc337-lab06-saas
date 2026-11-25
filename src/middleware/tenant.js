const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { forTenant } = require('../repo');

const cache = new Map(); // slug -> tenant row (tenants almost never change)

async function findTenant(slug) {
  if (cache.has(slug)) return cache.get(slug);
  const [rows] = await pool.query('SELECT id, slug, name FROM tenants WHERE slug = ?', [slug]);
  const tenant = rows[0] || null;
  if (tenant) cache.set(slug, tenant);
  return tenant;
}

/**
 * TENANT RESOLUTION MIDDLEWARE
 * Order of trust:  1) JWT claim   2) x-tenant-id header   3) subdomain (acme.localhost)
 * If a JWT and a header are both sent and disagree, we reject with 403 (spoofing attempt).
 * After this runs, req.db is a repository that is locked to ONE tenant.
 */
async function resolveTenant(req, res, next) {
  try {
    let slug = null;
    let source = null;

    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      try {
        req.user = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
        slug = req.user.tenant_slug;
        source = 'jwt';
      } catch (_) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
    }

    const header = req.headers['x-tenant-id'];
    if (header) {
      const h = String(header).toLowerCase();
      if (slug && h !== slug) {
        return res.status(403).json({ error: 'Tenant mismatch: token belongs to a different tenant' });
      }
      if (!slug) {
        slug = h;
        source = 'header';
      }
    }

    if (!slug) {
      const host = (req.headers.host || '').split(':')[0];
      const parts = host.split('.');
      if (parts.length >= 2 && !/^\d+$/.test(parts[0]) && parts[0] !== 'www') {
        const t = await findTenant(parts[0]);
        if (t) {
          slug = t.slug;
          source = 'subdomain';
        }
      }
    }

    if (!slug) {
      return res.status(400).json({ error: 'Tenant not identified. Send x-tenant-id header, a JWT, or use a tenant subdomain.' });
    }

    const tenant = await findTenant(slug);
    if (!tenant) return res.status(404).json({ error: 'Unknown tenant' });
    if (req.user && req.user.tenant_id !== tenant.id) {
      return res.status(403).json({ error: 'Tenant mismatch' });
    }

    req.tenant = tenant;
    req.tenantSource = source;
    req.db = forTenant(tenant.id);
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = { resolveTenant, requireAuth, requireAdmin };
