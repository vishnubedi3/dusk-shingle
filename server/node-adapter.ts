import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.js';
import { MAX_BODY_BYTES, type ApiRequest } from './http.js';
import { handle } from './router.js';

async function readBody(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  if (req.body !== undefined) return req.body; // pre-parsed by the platform
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('too_large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(',') : v;
}

/** Adapt a Node request to the framework-neutral API handler. */
export async function serveNode(req: IncomingMessage & { body?: unknown }, res: ServerResponse, getDb: () => Promise<Db> | undefined) {
  const url = new URL(req.url ?? '/', 'http://local');
  // Vercel rewrites /api/<x> → /api/router?route=<x>; the dev server passes the real path.
  const route = url.searchParams.get('route');
  const path = route !== null ? `/api/${route}` : url.pathname;
  const query = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'route'));

  const send = (status: number, payload: unknown, cookies: string[] = []) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.end(payload === undefined ? '' : JSON.stringify(payload));
  };

  const length = Number(header(req, 'content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return send(413, { error: { code: 'too_large', message: 'That request was too large.' } });
  let body: unknown;
  try {
    body = await readBody(req);
  } catch (error) {
    const tooLarge = (error as Error).message === 'too_large';
    return send(tooLarge ? 413 : 400, { error: { code: tooLarge ? 'too_large' : 'bad_request', message: tooLarge ? 'That request was too large.' : 'The request could not be read.' } });
  }
  if (typeof body === 'string' && req.body !== undefined && length > 0) {
    // Platform delivered a raw string (non-JSON content type) — refuse rather than guess.
    return send(415, { error: { code: 'bad_request', message: 'Requests must be JSON.' } });
  }

  const apiReq: ApiRequest = {
    method: (req.method ?? 'GET').toUpperCase(),
    path,
    query,
    headers: {
      cookie: header(req, 'cookie'),
      origin: header(req, 'origin'),
      host: header(req, 'host'),
      'x-forwarded-host': header(req, 'x-forwarded-host'),
      'x-forwarded-proto': header(req, 'x-forwarded-proto'),
      'x-dusk-client': header(req, 'x-dusk-client'),
    },
    body,
    ip: (header(req, 'x-forwarded-for') ?? '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown',
  };
  const result = await handle(apiReq, getDb);
  send(result.status, result.body, result.cookies);
}
