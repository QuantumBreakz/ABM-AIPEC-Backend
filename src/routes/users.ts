// Admin-only user management. Mounted behind requireRole('admin') in app.ts.
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { toUser } from '../db/mappers.js';
import { ROLES, User } from '../db/models.js';
import { badRequest, notFound } from '../lib/errors.js';

export const usersRoutes = Router();

const password = z.string().min(10, 'Password must be at least 10 characters').max(200);

usersRoutes.get('/', async (_req, res) => {
  res.json((await User.find().sort({ email: 1 }).lean()).map(toUser));
});

usersRoutes.post('/', async (req, res) => {
  const body = z.object({ email: z.email(), password, role: z.enum(ROLES) }).parse(req.body);
  const user = await User.create({ email: body.email, role: body.role, passwordHash: await bcrypt.hash(body.password, 12) });
  res.status(201).json(toUser(user.toObject()));
});

/** Never leave the system without an admin. */
async function assertNotLastAdmin(id: string) {
  const user = await User.findById(id).lean();
  if (!user) throw notFound('User not found');
  if (user.role === 'admin' && (await User.countDocuments({ role: 'admin' })) <= 1)
    throw badRequest('This is the last admin. Make someone else admin first.');
}

usersRoutes.patch('/:id', async (req, res) => {
  const body = z.object({ role: z.enum(ROLES).optional(), password: password.optional() }).parse(req.body);
  if (body.role === 'reviewer') await assertNotLastAdmin(req.params.id);
  const set: Record<string, unknown> = {};
  if (body.role) set.role = body.role;
  if (body.password) set.passwordHash = await bcrypt.hash(body.password, 12);
  const user = await User.findByIdAndUpdate(req.params.id, { $set: set }, { returnDocument: 'after' }).lean();
  if (!user) throw notFound('User not found');
  res.json(toUser(user));
});

usersRoutes.delete('/:id', async (req, res) => {
  if (req.params.id === req.user!.id) throw badRequest("You can't delete yourself");
  await assertNotLastAdmin(req.params.id);
  await User.deleteOne({ _id: req.params.id });
  res.sendStatus(204);
});
