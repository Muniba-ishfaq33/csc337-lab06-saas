require('dotenv').config();
const mysql = require('mysql2/promise');

// CONNECTION POOLING: the app keeps a fixed set of open connections and lends them
// out per query, instead of opening a brand new connection for every request.
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'lab06_saas',
  waitForConnections: true,                              // queue requests when all connections are busy
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10), // max open connections
  queueLimit: 0,                                          // 0 = unlimited waiting queue
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  decimalNumbers: true,                                   // DECIMAL columns come back as numbers
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

function poolStats() {
  const p = pool.pool;
  return {
    connectionLimit: p.config.connectionLimit,
    openConnections: p._allConnections ? p._allConnections.length : null,
    idleConnections: p._freeConnections ? p._freeConnections.length : null,
    queuedRequests: p._connectionQueue ? p._connectionQueue.length : null,
  };
}

module.exports = pool;
module.exports.poolStats = poolStats;
