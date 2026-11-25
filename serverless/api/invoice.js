const PDFDocument = require('pdfkit');

// ---- COLD START DETECTION ----
// Code outside the handler runs ONCE when the platform boots a fresh container.
// "isCold" is true only for the very first request that container serves.
const BOOT_TIME = Date.now();
let isCold = true;

function buildPdf(order) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(22).text('INVOICE', { align: 'right' });
    doc.moveDown(0.5).fontSize(11)
      .text(`Invoice #: INV-${order.order_id}`)
      .text(`Tenant: ${order.tenant}`)
      .text(`Date: ${new Date().toDateString()}`);
    doc.moveDown();

    doc.fontSize(12).text('Item', 50, doc.y, { continued: true, width: 250 })
      .text('Qty', { continued: true, width: 60 })
      .text('Price', { continued: true, width: 80 })
      .text('Line total');
    doc.moveTo(50, doc.y + 2).lineTo(550, doc.y + 2).stroke();
    doc.moveDown(0.5);

    for (const it of order.items) {
      const price = Number(it.unit_price);
      doc.fontSize(11).text(String(it.name || `Product ${it.product_id}`), 50, doc.y, { continued: true, width: 250 })
        .text(String(it.quantity), { continued: true, width: 60 })
        .text(price.toFixed(2), { continued: true, width: 80 })
        .text((price * it.quantity).toFixed(2));
    }
    doc.moveDown().fontSize(14).text(`TOTAL: ${Number(order.total).toFixed(2)}`, { align: 'right' });
    doc.end();
  });
}

module.exports = async (req, res) => {
  const start = Date.now();
  const wasCold = isCold;
  isCold = false; // every later request on this container is a WARM start

  // GET = quick browser demo with sample data. POST = real call from the Kafka consumer.
  let order;
  if (req.method === 'GET') {
    order = {
      order_id: 0, tenant: 'demo', total: 30,
      items: [{ name: 'Sample item', product_id: 1, quantity: 2, unit_price: 10 }, { name: 'Another item', product_id: 2, quantity: 1, unit_price: 10 }],
    };
  } else if (req.method === 'POST') {
    const secret = process.env.INVOICE_SECRET;
    if (secret && req.headers['x-invoice-secret'] !== secret) return res.status(401).json({ error: 'Bad secret' });
    order = req.body;
    if (!order || !Array.isArray(order.items)) return res.status(400).json({ error: 'order with items[] required' });
  } else {
    return res.status(405).json({ error: 'Use GET or POST' });
  }

  const pdf = await buildPdf(order);
  const executionMs = Date.now() - start;

  res.setHeader('X-Cold-Start', String(wasCold));
  if (req.method === 'GET' && req.query && req.query.download === '1') {
    res.setHeader('Content-Type', 'application/pdf');
    return res.status(200).send(pdf);
  }
  console.log(JSON.stringify({ cold_start: wasCold, execution_ms: executionMs, container_age_ms: Date.now() - BOOT_TIME }));
  res.status(200).json({
    invoice_number: `INV-${order.order_id}`,
    cold_start: wasCold,
    execution_ms: executionMs,
    container_age_ms: Date.now() - BOOT_TIME,
    pdf_bytes: pdf.length,
    pdf_base64_preview: pdf.toString('base64').slice(0, 60) + '...',
  });
};
