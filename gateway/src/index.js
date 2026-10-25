/**
 * VoizGen Gateway — Cloudflare Worker.
 *
 * Satu deploy melayani dua hal:
 *   1. berkas statis web app (lihat [assets] di wrangler.toml)
 *   2. /api/* sebagai registry + proxy ke worker Colab
 *
 * Alur:
 *   Colab  --POST /api/register (X-Register-Key)--> {code}         (dicetak di sel)
 *   Browser--POST /api/session  {code}          --> cookie vg
 *   Browser--GET/POST /api/health|/api/generate --> diteruskan ke tunnel + Bearer token
 *
 * URL tunnel dan token worker TIDAK pernah dikirim ke browser.
 */

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'; // tanpa 0/1/I/L/O/U — aman dibacakan
const CODE_LENGTH = 8;
const SESSION_TTL = 43200; // 12 jam, sama dengan umur wajar sesi Colab
const COOKIE = 'vg';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

/* ------------------------------------------------------------------ util */

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function prettyCode(code) {
  return code.slice(0, 4) + '-' + code.slice(4);
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function sessionCookie(request, value, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;
}

function authorizedWorker(request, env) {
  const key = env.REGISTER_KEY;
  if (!key) return false;
  const supplied = request.headers.get('X-Register-Key') || '';
  // panjang berbeda -> langsung gagal; timingSafeEqual butuh panjang sama
  if (supplied.length !== key.length) return false;
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual
    ? crypto.subtle.timingSafeEqual(enc.encode(supplied), enc.encode(key))
    : supplied === key;
}

async function lookupSession(request, env) {
  const code = normalizeCode(readCookie(request, COOKIE));
  if (!code) return null;
  const raw = await env.SESSIONS.get('code:' + code);
  if (!raw) return null;
  return { code, ...JSON.parse(raw) };
}

/* ------------------------------------------------------- worker endpoints */

async function register(request, env) {
  if (!authorizedWorker(request, env)) return json({ error: 'Register key tidak valid.' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body harus JSON.' }, 400);
  }

  const url = String(body.tunnel_url || '').trim().replace(/\/+$/, '');
  const token = String(body.worker_token || '').trim();
  // https wajib untuk tunnel nyata; http hanya diizinkan ke loopback (wrangler dev).
  const allowed = /^https:\/\/[^\s/]+/i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url);
  if (!allowed) return json({ error: 'tunnel_url harus URL https.' }, 400);
  if (!token) return json({ error: 'worker_token wajib.' }, 400);

  // kode lama dari sel yang di-run ulang: pakai kembali supaya user tidak bingung
  const wanted = normalizeCode(body.code);
  let code = wanted && wanted.length === CODE_LENGTH ? wanted : null;

  if (!code) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = newCode();
      if (!(await env.SESSIONS.get('code:' + candidate))) { code = candidate; break; }
    }
    if (!code) return json({ error: 'Gagal mengalokasikan kode, coba lagi.' }, 503);
  }

  await env.SESSIONS.put('code:' + code, JSON.stringify({ url, token, at: Date.now() }), {
    expirationTtl: SESSION_TTL,
  });

  return json({ code, pretty: prettyCode(code), expires_in: SESSION_TTL });
}

async function heartbeat(request, env) {
  if (!authorizedWorker(request, env)) return json({ error: 'Register key tidak valid.' }, 401);

  const { code: raw } = await request.json().catch(() => ({}));
  const code = normalizeCode(raw);
  const stored = code && (await env.SESSIONS.get('code:' + code));
  if (!stored) return json({ error: 'Kode tidak terdaftar.' }, 404);

  await env.SESSIONS.put('code:' + code, stored, { expirationTtl: SESSION_TTL });
  return json({ ok: true, expires_in: SESSION_TTL });
}

async function deregister(request, env) {
  if (!authorizedWorker(request, env)) return json({ error: 'Register key tidak valid.' }, 401);

  const { code: raw } = await request.json().catch(() => ({}));
  const code = normalizeCode(raw);
  if (code) await env.SESSIONS.delete('code:' + code);
  return json({ ok: true });
}

/* ------------------------------------------------------ browser endpoints */

async function openSession(request, env) {
  const { code: raw } = await request.json().catch(() => ({}));
  const code = normalizeCode(raw);
  if (code.length !== CODE_LENGTH) return json({ error: 'Kode akses harus 8 karakter.' }, 400);

  const entry = await env.SESSIONS.get('code:' + code);
  if (!entry) return json({ error: 'Kode tidak dikenal atau sudah kedaluwarsa. Jalankan ulang sel Colab.' }, 404);

  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, code, SESSION_TTL) });
}

function closeSession(request) {
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
}

/** Teruskan permintaan browser ke worker Colab; kredensial ditambahkan di sini. */
async function proxy(request, env, path) {
  const session = await lookupSession(request, env);
  if (!session) return json({ detail: 'Sesi tidak aktif. Masukkan kode akses lagi.' }, 401);

  const headers = new Headers({ Authorization: 'Bearer ' + session.token });
  const type = request.headers.get('Content-Type');
  if (type) headers.set('Content-Type', type);

  let upstream;
  try {
    upstream = await fetch(session.url + path, {
      method: request.method,
      headers,
      body: request.method === 'GET' ? undefined : request.body,
    });
  } catch (err) {
    return json({ detail: 'Worker Colab tidak dapat dijangkau: ' + err.message }, 502);
  }

  const out = new Headers({ 'Cache-Control': 'no-store' });
  for (const name of ['Content-Type', 'X-Elapsed', 'X-Segments', 'X-Notes']) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/* ----------------------------------------------------------------- router */

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const post = request.method === 'POST';

    if (pathname === '/api/gateway') {
      return json({
        gateway: true,
        code_length: CODE_LENGTH,
        // opsional: tautan Colab/Drive/GitHub per mesin, di-set lewat [vars]
        notebook_urls: {
          omnivoice: env.NOTEBOOK_URL || null,
          voxcpm2: env.NOTEBOOK_URL_VOXCPM2 || null,
        },
      });
    }

    if (pathname === '/api/register' && post) return register(request, env);
    if (pathname === '/api/heartbeat' && post) return heartbeat(request, env);
    if (pathname === '/api/deregister' && post) return deregister(request, env);

    if (pathname === '/api/session' && post) return openSession(request, env);
    if (pathname === '/api/logout' && post) return closeSession(request);

    if (pathname === '/api/health' && request.method === 'GET') return proxy(request, env, '/api/health');
    if (pathname === '/api/generate' && post) return proxy(request, env, '/api/generate');

    if (pathname.startsWith('/api/')) return json({ error: 'Endpoint tidak dikenal.' }, 404);

    // sisanya ditangani Workers Assets (web app statis)
    return env.ASSETS.fetch(request);
  },
};
