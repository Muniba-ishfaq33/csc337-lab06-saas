require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(async () => {
  const name = process.env.DB_NAME || 'lab06_saas';
  const base = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    multipleStatements: true,
  };

  try {
    const c = await mysql.createConnection(base);
    await c.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4`);
    await c.end();
  } catch (err) {
    console.warn('Could not create database (fine on cloud hosts where it already exists):', err.message);
  }

  const c = await mysql.createConnection({ ...base, database: name });
  await c.query(fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8'));
  const [v] = await c.query('SELECT VERSION() AS v');
  console.log(`Schema ready in database "${name}" (MySQL ${v[0].v})`);
  await c.end();
})().catch((e) => {
  console.error('init-db failed:', e.message);
  process.exit(1);
});
