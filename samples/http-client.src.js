#!/usr/bin/env node
/*
 * http-client.js
 * Kleiner HTTP-Client mit fetch: Header, JSON-Body, async/await, Timeout per
 * AbortController, Retry mit Backoff und parallele Requests.
 *
 * Damit das Ergebnis reproduzierbar ist, startet das Skript selbst einen kleinen
 * lokalen Testserver (127.0.0.1, zufaelliger Port) und schickt die Requests
 * dorthin. Es braucht also kein Internet. Am Ende steht eine Pruefsumme.
 *
 * Optional: node http-client.js https://httpbin.org/anything
 * schickt zusaetzlich einen echten Request an die angegebene URL.
 *
 * Braucht Node 18+ (globales fetch).
 *
 * MIT License
 * Copyright (c) 2026
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software, to deal in the Software without restriction, including the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
 * WARRANTY OF ANY KIND.
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const output = [];
function log(...parts) {
  const line = parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  output.push(line);
  console.log(line);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Lokaler Testserver
// ---------------------------------------------------------------------------
function startServer() {
  const flaky = new Map(); // zaehlt Versuche pro Request-ID
  const items = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');

    const send = (status, body, headers = {}) => {
      const json = JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json),
        'X-Server': 'mini-test',
        ...headers,
      });
      res.end(json);
    };

    // Auth fuer alles unter /api
    if (url.pathname.startsWith('/api/') && req.headers.authorization !== 'Bearer geheim123') {
      return send(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }

    switch (`${req.method} ${url.pathname}`) {
      case 'GET /echo':
        return send(200, {
          method: req.method,
          query: Object.fromEntries(url.searchParams),
          headers: {
            'user-agent': req.headers['user-agent'],
            accept: req.headers.accept,
            'x-request-id': req.headers['x-request-id'],
            'accept-language': req.headers['accept-language'],
          },
        });

      case 'POST /api/items': {
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          return send(400, { error: 'invalid json' });
        }
        if (typeof data.name !== 'string' || !data.name) return send(422, { error: 'name fehlt' });
        const item = { id: items.length + 1, name: data.name, tags: data.tags ?? [] };
        items.push(item);
        return send(201, item, { Location: `/api/items/${item.id}` });
      }

      case 'GET /api/items':
        return send(200, { count: items.length, items });

      case 'GET /flaky': {
        const id = req.headers['x-request-id'];
        const n = (flaky.get(id) ?? 0) + 1;
        flaky.set(id, n);
        if (n < 3) return send(503, { error: 'try again', attempt: n }, { 'Retry-After': '0' });
        return send(200, { ok: true, attempt: n });
      }

      case 'GET /slow':
        await sleep(Number(url.searchParams.get('ms') ?? 500));
        return send(200, { slow: true });

      case 'GET /hash': {
        const text = url.searchParams.get('text') ?? '';
        return send(200, { text, sha256: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) });
      }

      default:
        return send(404, { error: 'not found', path: url.pathname });
    }
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

class ApiClient {
  #baseUrl;
  #defaultHeaders;
  #requestCounter = 0;

  constructor(baseUrl, { token, userAgent = 'mini-client/1.0', language = 'de-DE' } = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#defaultHeaders = {
      'User-Agent': userAgent,
      Accept: 'application/json',
      'Accept-Language': language,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  #nextId() {
    this.#requestCounter += 1;
    return `req-${String(this.#requestCounter).padStart(3, '0')}`;
  }

  async request(path, { method = 'GET', query, body, headers = {}, timeoutMs = 2000, retries = 0, requestId } = {}) {
    const url = new URL(this.#baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));

    const finalHeaders = { ...this.#defaultHeaders, 'X-Request-Id': requestId ?? this.#nextId(), ...headers };
    const init = { method, headers: finalHeaders };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      finalHeaders['Content-Type'] = 'application/json';
    }

    let attempt = 0;
    for (;;) {
      attempt++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        const text = await res.text();
        const data = res.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;

        if (res.status >= 500 && attempt <= retries) {
          const wait = Number(res.headers.get('retry-after') ?? 0) * 1000 || 10 * 2 ** attempt;
          await sleep(wait);
          continue;
        }
        if (!res.ok) throw new HttpError(res.status, data);

        return {
          status: res.status,
          attempts: attempt,
          headers: {
            server: res.headers.get('x-server'),
            location: res.headers.get('location'),
          },
          data,
        };
      } catch (err) {
        if (err.name === 'AbortError' || controller.signal.aborted) {
          throw new Error(`Timeout nach ${timeoutMs} ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  get(path, opts) {
    return this.request(path, { ...opts, method: 'GET' });
  }

  post(path, body, opts) {
    return this.request(path, { ...opts, method: 'POST', body });
  }
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------
async function scenario(name, fn) {
  try {
    const result = await fn();
    log(`[ok]   ${name}:`, result);
  } catch (err) {
    log(`[fail] ${name}:`, err instanceof HttpError ? { status: err.status, body: err.body } : err.message);
  }
}

async function main() {
  const server = await startServer();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const client = new ApiClient(base, { token: 'geheim123' });
  const anon = new ApiClient(base, { userAgent: 'anon/0.1', language: 'en-US' });

  try {
    log('== Header & Query ==');
    await scenario('GET /echo', async () => {
      const r = await client.get('/echo', { query: { q: 'hallo welt', page: 2 }, headers: { 'X-Request-Id': 'eigene-id' } });
      return { status: r.status, server: r.headers.server, ...r.data };
    });

    log('== Auth ==');
    await scenario('ohne Token', () => anon.get('/api/items'));

    log('== POST mit JSON-Body ==');
    for (const body of [{ name: 'Apfel', tags: ['obst'] }, { name: 'Brot' }, { tags: ['kaputt'] }]) {
      await scenario(`POST ${JSON.stringify(body)}`, async () => {
        const { status, headers, data } = await client.post('/api/items', body);
        return { status, location: headers.location, data };
      });
    }
    await scenario('GET /api/items', async () => (await client.get('/api/items')).data);

    log('== Retry ==');
    await scenario('flaky ohne Retry', () => client.get('/flaky', { requestId: 'A' }));
    await scenario('flaky mit 3 Retries', async () => {
      const r = await client.get('/flaky', { requestId: 'B', retries: 3 });
      return { attempts: r.attempts, data: r.data };
    });

    log('== Timeout ==');
    await scenario('slow 300ms, Timeout 100ms', () => client.get('/slow', { query: { ms: 300 }, timeoutMs: 100 }));
    await scenario('slow 50ms, Timeout 500ms', async () => (await client.get('/slow', { query: { ms: 50 }, timeoutMs: 500 })).data);

    log('== Parallel ==');
    const words = ['alpha', 'beta', 'gamma', 'delta'];
    const results = await Promise.all(words.map(text => client.get('/hash', { query: { text } })));
    log('hashes:', results.map(r => `${r.data.text}=${r.data.sha256}`));

    const settled = await Promise.allSettled([
      client.get('/hash', { query: { text: 'ok' } }),
      client.get('/gibtsnicht'),
      client.get('/slow', { query: { ms: 200 }, timeoutMs: 20 }),
    ]);
    log('allSettled:', settled.map(s => (s.status === 'fulfilled' ? 'fulfilled' : `rejected(${s.reason.message})`)));

    log('== Pruefsumme ==');
    const sum = crypto.createHash('sha256').update(output.join('\n')).digest('hex').slice(0, 12);
    console.log(sum);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  // Optionaler echter Request ins Internet (geht nicht in die Pruefsumme ein)
  const external = process.argv[2];
  if (external) {
    console.log(`\n== Externer Request an ${external} ==`);
    try {
      const res = await fetch(external, {
        headers: { 'User-Agent': 'mini-client/1.0', Accept: 'application/json', 'X-Demo': '1' },
        signal: AbortSignal.timeout(5000),
      });
      console.log('Status:', res.status, res.statusText);
      console.log('Content-Type:', res.headers.get('content-type'));
      console.log((await res.text()).slice(0, 500));
    } catch (err) {
      console.log('Fehler:', err.message);
    }
  }
}

main().catch(err => {
  console.error('Unerwarteter Fehler:', err);
  process.exitCode = 1;
});
