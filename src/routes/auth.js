const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { wrap } = require('../utils');

const router = express.Router();

// POST /api/v1/auth/login   (tenant comes from the x-tenant-id header or subdomain)
router.post(
  '/login',
  wrap(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const user = await req.db.findUserByEmail(String(email).toLowerCase());
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) return res.status(401).json({ error: 'Wrong email or password for this tenant' });

    const token = jwt.sign(
      { sub: user.id, email: user.email, role: user.role, tenant_id: req.tenant.id, tenant_slug: req.tenant.slug },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );
    res.json({
      token,
      tenant: { id: req.tenant.id, slug: req.tenant.slug, name: req.tenant.name },
      user: { id: user.id, email: user.email, role: user.role },
    });
  })
);

module.exports = router;
