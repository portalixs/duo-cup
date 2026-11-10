const initial = JSON.stringify({ started: false, rounds: [], results: {}, active: null, streamUrl: '' });
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function equalKey(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/state' && request.method === 'GET') {
      const row = await env.DB.prepare('SELECT body FROM tournament_snapshot WHERE id = 1').first();
      return new Response(row?.body ?? initial, { headers: jsonHeaders });
    }
    if (pathname === '/api/publish' && request.method === 'PUT') {
      if (!env.PUBLISH_KEY || !equalKey(request.headers.get('authorization'), `Bearer ${env.PUBLISH_KEY}`)) {
        return new Response('Unauthorized', { status: 401 });
      }
      const body = await request.text();
      if (body.length > 32_768) return new Response('Too large', { status: 413 });
      try { JSON.parse(body); } catch { return new Response('Invalid JSON', { status: 400 }); }
      await env.DB.prepare('INSERT INTO tournament_snapshot (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').bind(body).run();
      return new Response(null, { status: 204 });
    }
    const asset = request.method === 'GET' && Object.hasOwn(assets, pathname) && assets[pathname];
    if (!asset) return new Response('Страница не найдена', { status: 404 });
    return new Response(asset[1], { headers: {
      'Content-Type': `${asset[0]}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    } });
  },
};
