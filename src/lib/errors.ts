// Every error leaves the API in one shape: { error: { code, message, details? } } (see API contract).
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
import { isProd } from '../env.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Please log in') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details);

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const send = (status: number, code: string, message: string, details?: unknown) =>
    res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } });

  if (err instanceof HttpError) return send(err.status, err.code, err.message, err.details);
  if (err instanceof z.ZodError) return send(400, 'bad_request', 'Invalid input', z.flattenError(err));
  if (err?.type === 'entity.parse.failed') return send(400, 'bad_request', 'Body is not valid JSON');
  if (err?.name === 'CastError') return send(400, 'bad_request', `Invalid value for ${err.path}`);
  if (err?.code === 11000) return send(409, 'conflict', 'That record already exists', err.keyValue);

  req.log?.error({ err }, 'unhandled error');
  return send(500, 'internal', isProd ? 'Something went wrong' : String(err?.message ?? err));
};
