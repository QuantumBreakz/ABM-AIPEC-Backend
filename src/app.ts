/**
 * The HTTP app, with no listen() and no workers, so tests can import it directly.
 * Order matters: public routes → login check → protected routes → 404 → error handler.
 */
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { requireAuth, requireRole } from './lib/auth.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { log } from './lib/logger.js';
import { companyAiRoutes, contactAiRoutes } from './routes/ai.js';
import { authRoutes } from './routes/auth.js';
import { companiesRoutes } from './routes/companies.js';
import { companyContactsRoutes, contactsRoutes } from './routes/contacts.js';
import { eventsRoutes } from './routes/events.js';
import { exportsRoutes } from './routes/exports.js';
import { reviewRoutes } from './routes/review.js';
import { runsRoutes } from './routes/runs.js';
import { settingsRoutes, suppressionsRoutes } from './routes/settings.js';
import { reportsRoutes, statsRoutes } from './routes/stats.js';
import { systemRoutes } from './routes/system.js';
import { usersRoutes } from './routes/users.js';
import { verificationRoutes } from './routes/verification.js';

export const app = express();

// Requests reach us through Vercel's /api rewrite and then Render's proxy: 2 hops.
// This makes req.ip the real visitor IP, which the login rate limit relies on.
app.set('trust proxy', 2);
app.disable('x-powered-by');
app.use(helmet());
app.use(pinoHttp({ logger: log, autoLogging: { ignore: (req) => req.url === '/health' } }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Public
app.use(systemRoutes);
app.use('/auth', authRoutes);

// Everything below needs a logged-in user
app.use(requireAuth);
app.use('/users', requireRole('admin'), usersRoutes);
app.use('/events', eventsRoutes);
app.use('/runs', runsRoutes);
app.use('/companies', companiesRoutes);
app.use('/companies', companyContactsRoutes);
app.use('/companies', companyAiRoutes);
app.use('/contacts', contactsRoutes);
app.use('/contacts', contactAiRoutes);
app.use('/review', reviewRoutes);
app.use('/exports', exportsRoutes);
app.use('/verification', verificationRoutes);
app.use('/settings', settingsRoutes);
app.use('/suppressions', suppressionsRoutes);
app.use('/stats', statsRoutes);
app.use('/reports', reportsRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
