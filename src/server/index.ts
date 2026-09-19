/**
 * The server that runs next to Anki. It reads AnkiConnect, applies the
 * glasses filter, and serves the web app that the Even App WebView loads.
 *
 * It has to listen on a real network interface so the phone can reach it, and
 * it can read a private collection and write scheduling. So every endpoint
 * that touches the collection requires a key. The key travels in the URL the
 * phone opens, which is exactly what the pairing QR code encodes.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ease } from '../shared/types.js';
import { AnkiClient, AnkiError } from './ankiconnect.js';
import { loadConfig, type AppConfig } from './config.js';
import { ReviewSession } from './session.js';
import { buildReport } from './report.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

export const ACCESS_HEADER = 'x-anki-glasses-key';

/**
 * Walk up from a module to the directory holding package.json.
 *
 * The compiled server sits at dist/server/server/index.js and the app is built
 * to dist/app, so a path relative to the module is different in source and in
 * build. Anchoring on the package root makes both work.
 */
function packageRoot(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function corsHeaders(origin: string | undefined, allowed: string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': `Content-Type, ${ACCESS_HEADER}`,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const piece of req) {
    const buffer = piece as Buffer;
    total += buffer.length;
    if (total > limitBytes) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isEase(value: unknown): value is Ease {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

/** Constant time comparison that tolerates different lengths. */
function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface ServerHandle {
  port: number;
  accessKey: string;
  /** The address to open on the phone, key included. */
  url: (host?: string) => string;
  close: () => Promise<void>;
}

export async function startServer(config: AppConfig, staticRoot?: string): Promise<ServerHandle> {
  const anki = new AnkiClient({ url: config.ankiConnectUrl, apiKey: config.ankiConnectKey });
  const root = staticRoot ? resolve(staticRoot) : join(packageRoot(import.meta.url), 'dist/app');
  const accessKey = config.accessKey ?? randomBytes(16).toString('base64url');

  let session: ReviewSession | null = null;

  const ensureSession = async (): Promise<ReviewSession> => {
    if (!session) {
      session = new ReviewSession(anki, { ...config.session, filter: config.filter });
      await session.start();
    }
    return session;
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const isAnki = error instanceof AnkiError;
      sendJson(res, isAnki ? 502 : 500, {
        error: String(error instanceof Error ? error.message : error),
        // A short code so the glasses can show something a wearer can act on
        // instead of an http status and a json blob.
        code: isAnki ? 'anki-unreachable' : 'server-error',
      });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const cors = corsHeaders(req.headers.origin, config.allowedOrigins);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    // Open, and says nothing about the collection beyond whether Anki answers.
    if (path === '/api/health') {
      const version = await anki.version();
      sendJson(res, 200, { ok: true, ankiConnect: version }, cors);
      return;
    }

    if (path.startsWith('/api/')) {
      const supplied =
        (req.headers[ACCESS_HEADER] as string | undefined) ?? url.searchParams.get('k') ?? '';
      if (!secretsMatch(supplied, accessKey)) {
        sendJson(res, 401, { error: 'Missing or wrong access key', code: 'bad-key' }, cors);
        return;
      }
    }

    if (path === '/api/config') {
      sendJson(res, 200, { grades: config.grades, layout: config.filter.layout }, cors);
      return;
    }

    if (path === '/api/session/start' && req.method === 'POST') {
      // Resume rather than replace. A reloaded WebView, or a second phone
      // holding the same pairing url, would otherwise orphan the token the
      // wearer is in the middle of grading with and lose that grade.
      if (session && session.isActive()) {
        sendJson(res, 200, session.state(), cors);
        return;
      }
      session = new ReviewSession(anki, { ...config.session, filter: config.filter });
      sendJson(res, 200, await session.start(), cors);
      return;
    }

    if (path === '/api/session/next') {
      const active = await ensureSession();
      sendJson(res, 200, await active.next(), cors);
      return;
    }

    if (path === '/api/session/answer' && req.method === 'POST') {
      const body = (await readJsonBody(req)) as { token?: unknown; ease?: unknown };
      if (typeof body.token !== 'string' || !isEase(body.ease)) {
        sendJson(res, 400, { error: 'answer needs a token and an ease of 1 to 4' }, cors);
        return;
      }
      const active = await ensureSession();
      sendJson(res, 200, await active.answer(body.token, body.ease), cors);
      return;
    }

    if (path === '/api/report') {
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '400', 10);
      const report = await buildReport(anki, config.filter, Number.isFinite(limit) ? limit : 400);
      sendJson(res, 200, report, cors);
      return;
    }

    if (path.startsWith('/api/')) {
      sendJson(res, 404, { error: `No such endpoint: ${path}` }, cors);
      return;
    }

    serveStatic(root, path, res);
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;

  return {
    port,
    accessKey,
    url: (host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host) =>
      `http://${host}:${port}/?k=${accessKey}`,
    close: () =>
      new Promise<void>((done, fail) => {
        server.close((error) => (error ? fail(error) : done()));
      }),
  };
}

function serveStatic(root: string, path: string, res: ServerResponse): void {
  const relative = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
  let target = join(root, relative === '/' || relative === sep ? 'index.html' : relative);

  if (!target.startsWith(root)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  if (existsSync(target) && statSync(target).isDirectory()) {
    target = join(target, 'index.html');
  }
  if (!existsSync(target)) {
    // The app is a single page, so unknown paths fall back to it.
    const fallback = join(root, 'index.html');
    if (!existsSync(fallback)) {
      sendJson(res, 404, {
        error: `Not found: ${path}. Looked in ${root}. Has the app been built with npm run build?`,
      });
      return;
    }
    target = fallback;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(target).pipe(res);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const config = loadConfig();
  startServer(config)
    .then((handle) => {
      process.stdout.write(
        `anki-glasses listening on ${config.host}:${handle.port}, Anki at ${config.ankiConnectUrl}\n` +
          `Open this on the phone, the key is required:\n  ${handle.url()}\n` +
          `Replace 127.0.0.1 with this machine's LAN or Tailscale address for the phone.\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`Failed to start: ${String(error)}\n`);
      process.exit(1);
    });
}
