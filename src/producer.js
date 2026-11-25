const { kafka, TOPIC } = require('./config/kafka');

let producer = null;
let connecting = null;

async function getProducer() {
  if (producer) return producer;
  if (!connecting) {
    const p = kafka.producer({ allowAutoTopicCreation: true });
    connecting = p
      .connect()
      .then(() => {
        producer = p;
        return p;
      })
      .catch((err) => {
        connecting = null;
        throw err;
      });
  }
  return connecting;
}

// MESSAGE KEY = tenant_id. Kafka hashes the key to choose a partition, so every event of one
// tenant lands in the SAME partition, and a partition keeps messages in order.
async function publishOrderCreated(event) {
  const p = await getProducer();
  const result = await p.send({
    topic: TOPIC,
    acks: -1,
    messages: [
      {
        key: String(event.tenant_id),
        value: JSON.stringify(event),
        headers: { 'event-type': 'OrderCreated' },
      },
    ],
  });
  return { topic: TOPIC, partition: result[0].partition, offset: result[0].baseOffset };
}

async function disconnectProducer() {
  if (producer) await producer.disconnect().catch(() => {});
}

module.exports = { publishOrderCreated, disconnectProducer };
