/**
 * Create (or reset) an admin user. Prompts for the password so it never lands in shell history.
 *   npm run create-admin -- you@company.com
 * For production: run it from your machine with MONGO_URL in .env pointing at Atlas.
 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { User } from '../src/db/models.js';
import { env } from '../src/env.js';

// Readline echoes typing through `output`; muting it while the password is typed keeps the
// password out of the terminal scrollback.
let muted = false;
const output = new Writable({
  write(chunk, _enc, done) {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
const email = (process.argv[2] ?? (await rl.question('Admin email: '))).trim().toLowerCase();

process.stdout.write('Password (min 8 chars, hidden): ');
muted = true;
const password = await rl.question('');
muted = false;
process.stdout.write('\n');
rl.close();

const fail = (msg: string) => {
  console.error(msg);
  process.exit(1);
};
if (!/^\S+@\S+\.\S+$/.test(email)) fail('That is not an email address.');
if (password.length < 8) fail('Password must be at least 8 characters.');

await mongoose.connect(env.MONGO_URL);
await User.updateOne({ email }, { $set: { role: 'admin', passwordHash: await bcrypt.hash(password, 12) } }, { upsert: true });
console.log(`Admin ready: ${email}`);
await mongoose.disconnect();
