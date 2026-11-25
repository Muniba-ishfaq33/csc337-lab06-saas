require('dotenv').config();
const { kafka, TOPIC, ensureTopic } = require('./config/kafka');
const { forTenant } = require('./repo');

const GROUP_ID = process.env.KAFKA_GROUP_ID || 'order-processors';

// Calls the serverless function (Vercel) to build an invoice and records cold/warm timing.
async function requestInvoice(db, event) {
  const url = process.env.INVOICE_FUNCTION_URL;
  if (!url) return 'no invoice function configured';
  const order = await db.getOrder(event.order_id);
  if (!order) return 'order missing';

  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-invoice-secret': process.env.INVOICE_SECRET || '' },
      body: JSON.stringify({
        order_id: order.id,
        tenant: event.tenant_slug,
        total: order.total,
        items: order.items,
      }),
    });
    const data = await resp.json();
    const roundtrip = Date.now() - t0;
    if (!resp.ok) return `invoice error ${resp.status}`;
    await db.logInvoice(order.id, data.cold_start, data.execution_ms, roundtrip);
    return `invoice ${data.cold_start ? 'COLD' : 'warm'} start, function ${data.execution_ms}ms, round-trip ${roundtrip}ms`;
  } catch (err) {
    return `invoice call failed: ${err.message}`;
  }
}

async function startConsumer() {
  await ensureTopic();
  const consumer = kafka.consumer({ groupId: GROUP_ID });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
  console.log(`[consumer] group "${GROUP_ID}" listening on topic "${TOPIC}"`);

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const key = message.key ? message.key.toString() : null;
      let event;
      try {
        event = JSON.parse(message.value.toString());
      } catch (_) {
        console.warn(`[consumer] bad JSON at partition=${partition} offset=${message.offset}, skipped`);
        return;
      }

      const db = forTenant(event.tenant_id); // work happens inside this tenant only
      const where = `partition=${partition} offset=${message.offset} key=${key}`;

      if (await db.wasEventProcessed(event.event_id)) {
        console.log(`[consumer] ${where} duplicate event ${event.event_id}, skipped`);
        return;
      }

      const result = await db.fulfillOrder(event.order_id);
      await db.logProcessedEvent({
        event_id: event.event_id,
        order_id: event.order_id,
        topic,
        partition,
        offset: message.offset,
        outcome: result.outcome,
      });

      let invoiceNote = '';
      if (result.ok && result.outcome === 'COMPLETED') invoiceNote = ' | ' + (await requestInvoice(db, event));
      console.log(`[consumer] ${where} -> ${event.tenant_slug} order #${event.order_id}: ${result.outcome}${invoiceNote}`);
    },
  });

  const stop = async () => {
    await consumer.disconnect().catch(() => {});
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return consumer;
}

module.exports = { startConsumer };

if (require.main === module) {
  startConsumer().catch((err) => {
    console.error('[consumer] fatal:', err);
    process.exit(1);
  });
}
