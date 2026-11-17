import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { toUser } from '../db/mappers.js';
import { User } from '../db/models.js';
import { endSession, requireAuth, startSession } from '../lib/auth.js';
import { conflict, forbidden, unauthorized } from '../lib/errors.js';

export const authRoutes = Router();

// 10 failed tries per 15 min per IP+email. Successful logins don't count.
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '', 56)}|${String(req.body?.email ?? '').toLowerCase()}`,
  handler: (_req, res) => {
    res.status(429).json({ error: { code: 'rate_limited', message: 'Too many login attempts. Try again in 15 minutes.' } });
  },
});

// Compared against when the email doesn't exist, so response time doesn't reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

authRoutes.post('/login', loginLimit, async (req, res) => {
  const { email, password } = z.object({ email: z.email(), password: z.string().min(1) }).parse(req.body);
  const user = await User.findOne({ email: email.toLowerCase() }).lean();
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Wrong email or password');
  if (user.active === false) throw forbidden('This account has been deactivated. Contact an administrator.');
  startSession(res, user);
  res.json(toUser(user));
});

authRoutes.post('/signup', loginLimit, async (req, res) => {
  const body = z
    .object({
      email: z.email(),
      username: z.string().trim().min(2, 'Username must be at least 2 characters').max(80).optional(),
      password: z.string().min(8, 'Password must be at least 8 characters').max(200),
    })
    .parse(req.body);
  if (await User.exists({ email: body.email.toLowerCase() })) throw conflict('An account with this email already exists');
  const user = await User.create({
    email: body.email.toLowerCase(),
    username: body.username,
    role: 'user',
    active: true,
    passwordHash: await bcrypt.hash(body.password, 12),
  });
  startSession(res, user);
  res.status(201).json(toUser(user.toObject()));
});

authRoutes.post('/logout', (_req, res) => {
  endSession(res);
  res.sendStatus(204);
});

authRoutes.get('/me', requireAuth, async (req, res) => {
  res.json(toUser((await User.findById(req.user!.id).lean())!));
});
