/**
 * Login = a signed JWT in an httpOnly cookie called `sid`.
 * The browser can't read it (no XSS token theft), and through the Vercel /api rewrite it's a first-party cookie.
 * Every request re-loads the user, so deleting a user or changing their role takes effect immediately.
 */
import type { RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '../contract.js';
import { User } from '../db/models.js';
import { env, isProd } from '../env.js';
import { forbidden, unauthorized } from './errors.js';

export type SessionUser = { id: string; email: string; role: Role };

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

const COOKIE = 'sid';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const cookieOpts = { httpOnly: true, secure: isProd, sameSite: 'lax' as const, path: '/' };

export function startSession(res: Response, user: { _id: unknown; role?: string | null }) {
  const token = jwt.sign({ role: user.role }, env.JWT_SECRET, { subject: String(user._id), expiresIn: '7d' });
  res.cookie(COOKIE, token, { ...cookieOpts, maxAge: MAX_AGE });
}

export const endSession = (res: Response) => res.clearCookie(COOKIE, cookieOpts);

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const token = req.cookies?.[COOKIE];
  if (!token) throw unauthorized();
  let sub: string | undefined;
  try {
    sub = (jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload).sub;
  } catch {
    throw unauthorized('Session expired, please log in again');
  }
  const user = sub ? await User.findById(sub, { email: 1, role: 1 }).lean() : null;
  if (!user) throw unauthorized();
  req.user = { id: String(user._id), email: user.email, role: user.role as Role };
  next();
};

export const requireRole =
  (role: Role): RequestHandler =>
  (req, _res, next) => {
    if (req.user?.role !== role) throw forbidden();
    next();
  };
