require('dotenv').config();
const path = require('path');
const express = require('express');
const pool = require('./config/db');
const { poolStats } = require('./config/db');
const { ensureTopic } = require('./config/kafka');
const { resolveTenant, requireAuth } = require('./middleware/tenant');
const { disconnectProducer } = require('./producer');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// public (no tenant needed)
app.get('/api/v1/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', pool: poolStats() });
  } catch (err) {
    res.status(500).json({ status: 'db down', error: err.message });
  }
});

app.use('/api/v1/auth', resolveTenant, authRoutes);   // tenant from header/subdomain
app.use('/api/v1', resolveTenant, requireAuth, apiRoutes); // tenant from JWT, then scoped repo

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = Number(process.env.PORT || 3000);
const server = app.listen(PORT, async () => {
  console.log(`API running on http://localhost:${PORT}`);
  await ensureTopic();
  if (process.env.RUN_CONSUMER_IN_API === 'true') {
    require('./consumer').startConsumer().catch((e) => console.error('[consumer] failed to start:', e.message));
  }
});

async function shutdown() {
  console.log('Shutting down...');
  server.close();
  await disconnectProducer();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
