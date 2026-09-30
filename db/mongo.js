const mongoose = require('mongoose');
const StatementDocument = require('../src/models/StatementDocument');
const AuditLog = require('../src/models/AuditLog');

async function connectMongo({ retries = 10, delayMs = 2000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 5000 });
      break;
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  await Promise.all([StatementDocument.init(), AuditLog.init()]);
  return mongoose.connection;
}

async function closeMongo() {
  await mongoose.disconnect();
}

module.exports = { connectMongo, closeMongo };
