import { Queue, Worker } from 'bullmq';
import { db } from '../db/client';
import { sendEmail } from '../utils/notifier';

export const fulfillmentQueue = new Queue('fulfillment', {
  connection: { host: 'localhost', port: 6379 }
});

export async function enqueueFulfillment(orderId: string) {
  await fulfillmentQueue.add('fulfill', { orderId });
}

export function startFulfillmentWorker() {
  return new Worker(
    'fulfillment',
    async job => {
      const { orderId } = job.data;
      await db.query(`UPDATE orders SET status = 'fulfilled' WHERE id = $1`, [orderId]);
      await db.query(`INSERT INTO shipments (order_id) VALUES ($1)`, [orderId]);
      await sendEmail('ops@example.com', 'Shipment ready', `Order ${orderId} ready to ship`);
    },
    { connection: { host: 'localhost', port: 6379 } }
  );
}

export async function processJob(jobId: string) {
  return fulfillmentQueue.getJob(jobId);
}
