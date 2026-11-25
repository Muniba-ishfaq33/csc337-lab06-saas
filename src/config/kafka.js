require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Kafka, logLevel } = require('kafkajs');

const TOPIC = process.env.KAFKA_TOPIC || 'tenant.orders';

// Reads a certificate either from a file path (local PC) or from an env variable that holds
// the text itself (hosting like Render, where you paste the certificate into an env var).
function readCert(pathVar, textVar) {
  if (process.env[pathVar]) return fs.readFileSync(path.resolve(process.env[pathVar]), 'utf8');
  if (process.env[textVar]) return process.env[textVar].replace(/\\n/g, '\n');
  return undefined;
}

function buildSsl() {
  const ca = readCert('KAFKA_SSL_CA_PATH', 'KAFKA_SSL_CA');
  const cert = readCert('KAFKA_SSL_CERT_PATH', 'KAFKA_SSL_CERT');
  const key = readCert('KAFKA_SSL_KEY_PATH', 'KAFKA_SSL_KEY');
  // Aiven style: client certificate login
  if (ca || cert || key) return { rejectUnauthorized: true, ca: ca ? [ca] : undefined, cert, key };
  return process.env.KAFKA_SSL === 'true';
}

const kafka = new Kafka({
  clientId: 'lab06-saas',
  brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',').map((b) => b.trim()),
  ssl: buildSsl(),
  // username/password login (SASL) - only used if KAFKA_USERNAME is filled
  sasl: process.env.KAFKA_USERNAME
    ? {
        mechanism: process.env.KAFKA_SASL_MECHANISM || 'scram-sha-256',
        username: process.env.KAFKA_USERNAME,
        password: process.env.KAFKA_PASSWORD,
      }
    : undefined,
  logLevel: logLevel.WARN,
    connectionTimeout: 20000,
  authenticationTimeout: 20000,
  requestTimeout: 30000,
  retry: { initialRetryTime: 1000, retries: 8 },
});

// Tries to create the topic. On Aiven free tier create it in the Aiven Console instead
// (2 partitions); then this just prints a warning and carries on.
async function ensureTopic() {
  const admin = kafka.admin();
  try {
    await admin.connect();
    const created = await admin.createTopics({
      waitForLeaders: true,
      topics: [{ topic: TOPIC, numPartitions: Number(process.env.KAFKA_PARTITIONS || 2) }],
    });
    console.log(created ? `[kafka] topic "${TOPIC}" created` : `[kafka] topic "${TOPIC}" ready`);
  } catch (err) {
    console.warn(`[kafka] could not create topic automatically (${err.message}). Create "${TOPIC}" in your Kafka dashboard if it does not exist.`);
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

module.exports = { kafka, TOPIC, ensureTopic };
