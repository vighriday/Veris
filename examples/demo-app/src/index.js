// Entry. Exercises prototype + module.exports = function patterns.
const express = require('express');
const { router } = require('./routes/api');
const { startFulfillmentWorker } = require('./queue/fulfillment');

function PaymentReconciler() {
  this.cursor = 0;
}

PaymentReconciler.prototype.reconcile = function reconcile() {
  this.cursor += 1;
  return this.cursor;
};

PaymentReconciler.prototype.replay = function replay(eventId) {
  return { replayed: eventId };
};

function bootstrap() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  startFulfillmentWorker();
  return app;
}

module.exports = bootstrap;
module.exports.PaymentReconciler = PaymentReconciler;
