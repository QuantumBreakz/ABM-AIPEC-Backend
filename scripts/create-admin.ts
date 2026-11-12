/**
 * Create (or reset) an admin user. Prompts for the password so it never lands in shell history.
 *   npm run create-admin -- you@company.com
 * For production: run it from your machine with MONGO_URL in .env pointing at Atlas.
 */
import { createInterface } from 'node:readline/promises';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { User } from '../src/db/models.js';
import { env } from '../src/env.js';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const email = (process.argv[2] ?? (await rl.question('Admin email: '))).trim().toLowerCase();
const password = await rl.question('Password (min 10 chars): ');
rl.close();

if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('That is not an email address');
if (password.length < 10) throw new Error('Password must be at least 10 characters');

await mongoose.connect(env.MONGO_URL);
await User.updateOne({ email }, { $set: { role: 'admin', passwordHash: await bcrypt.hash(password, 12) } }, { upsert: true });
console.log(`Admin ready: ${email}`);
await mongoose.disconnect();
