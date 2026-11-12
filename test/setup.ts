// Runs before every test file: point it at a fresh database, connect, and drop that database afterwards.
import mongoose from 'mongoose';
import { afterAll, beforeAll } from 'vitest';

const url = new URL(process.env.MONGO_URL!);
url.pathname = `/adipec_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
process.env.MONGO_URL = url.href;

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URL!);
  await mongoose.syncIndexes(); // unique indexes matter for the duplicate tests
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
