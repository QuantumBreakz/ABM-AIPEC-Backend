// Admin-only user management. Mounted behind requireRole('admin') in app.ts.
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { toUser } from '../db/mappers.js';
import { ROLES, User } from '../db/models.js';
import { conflict, notFound } from '../lib/errors.js';

export const usersRoutes = Router();

const password = z.string().min(8, 'Password must be at least 8 characters').max(200);
const username = z.string().trim().min(2, 'Username must be at least 2 characters').max(80);

usersRoutes.get('/', async (_req, res) => {
  res.json((await User.find().sort({ email: 1 }).lean()).map(toUser));
});

usersRoutes.post('/', async (req, res) => {
  const body = z
    .object({
      email: z.email(),
      username: username.optional(),
      password,
      role: z.enum(ROLES).default('user'),
      active: z.boolean().default(true),
    })
    .parse(req.body);
  if (await User.exists({ email: body.email.toLowerCase() })) throw conflict('A user with this email already exists');
  const user = await User.create({
    email: body.email.toLowerCase(),
    username: body.username,
    role: body.role,
    active: body.active,
    passwordHash: await bcrypt.hash(body.password, 12),
  });
  res.status(201).json(toUser(user.toObject()));
});

/** Never leave the system without an active admin. */
async function assertNotLastAdmin(id: string) {
  const user = await User.findById(id).lean();
  if (!user) throw notFound('User not found');
  if (user.role === 'admin' && (await User.countDocuments({ role: 'admin', active: { $ne: false } })) <= 1) {
    throw conflict('This is the last active admin. Make someone else admin first.');
  }
}

usersRoutes.patch('/:id', async (req, res) => {
  const body = z
    .object({
      email: z.email().optional(),
      username: username.nullable().optional(),
      role: z.enum(ROLES).optional(),
      password: password.optional(),
      active: z.boolean().optional(),
    })
    .parse(req.body);

  if (req.params.id === req.user!.id && body.active === false) {
    throw conflict('You cannot deactivate your own account');
  }
  if ((body.role && body.role !== 'admin') || body.active === false) {
    await assertNotLastAdmin(req.params.id);
  }

  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  if (body.email) {
    const email = body.email.toLowerCase();
    const existing = await User.findOne({ email, _id: { $ne: req.params.id } }, { _id: 1 }).lean();
    if (existing) throw conflict('A user with this email already exists');
    set.email = email;
  }
  if (body.username !== undefined) {
    if (body.username === null || body.username === '') unset.username = 1;
    else set.username = body.username;
  }
  if (body.role) set.role = body.role;
  if (body.active !== undefined) set.active = body.active;
  if (body.password) set.passwordHash = await bcrypt.hash(body.password, 12);

  const update: Record<string, unknown> = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  if (!Object.keys(update).length) {
    const current = await User.findById(req.params.id).lean();
    if (!current) throw notFound('User not found');
    return res.json(toUser(current));
  }

  const user = await User.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' }).lean();
  if (!user) throw notFound('User not found');
  res.json(toUser(user));
});

usersRoutes.delete('/:id', async (req, res) => {
  if (req.params.id === req.user!.id) throw conflict('You cannot delete your own account');
  await assertNotLastAdmin(req.params.id);
  await User.deleteOne({ _id: req.params.id });
  res.sendStatus(204);
});
