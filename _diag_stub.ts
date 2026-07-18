import http from 'node:http';

const SET = { id: 'set-uid', slug: 'frost_prime_set', tags: ['prime'], ducats: 0 };

const PARTS = [
  { uid: '54a73e65e779893a797fff80', slug: 'frost_prime_blueprint', quantityInSet: 1, ducats: 45 },
  { uid: '54a73e65e779893a797fff7d', slug: 'frost_prime_chassis_blueprint', quantityInSet: 1, ducats: 100 },
  { uid: '54a73e65e779893a797fff6c', slug: 'frost_prime_neuroptics_blueprint', quantityInSet: 1, ducats: 45 },
  { uid: '54a73e65e779893a797fff79', slug: 'frost_prime_systems_blueprint', quantityInSet: 1, ducats: 30 },
  { uid: '56783f24cbfa8f0432dd899c', slug: 'frost_prime_set', quantityInSet: 1, ducats: 0 },
];

const BULK_ITEMS = [
  SET,
  { id: 'p1', slug: 'frost_prime_blueprint', tags: ['prime'], ducats: 45 },
  { id: 'p2', slug: 'frost_prime_chassis_blueprint', tags: ['prime'], ducats: 100 },
  { id: 'np', slug: 'non_prime_weapon', tags: ['weapon'], ducats: 0 },
];

const ORDERS = {
  frost_prime_set: [40, 50, 60].map((p) => ({ type: 'sell', visible: true, user: { status: 'ingame' }, platinum: p })),
  frost_prime_blueprint: [3, 4].map((p) => ({ type: 'sell', visible: true, user: { status: 'ingame' }, platinum: p })),
  frost_prime_chassis_blueprint: [4, 5].map((p) => ({ type: 'sell', visible: true, user: { status: 'ingame' }, platinum: p })),
  frost_prime_neuroptics_blueprint: [5, 6].map((p) => ({ type: 'sell', visible: true, user: { status: 'ingame' }, platinum: p })),
  frost_prime_systems_blueprint: [3, 4].map((p) => ({ type: 'sell', visible: true, user: { status: 'ingame' }, platinum: p })),
};

const STAT_VOLUME = 25;

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = req.url ?? '';
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    send(url);
  });

  function send(url: string) {
    if (url === '/v2/items') {
      res.end(JSON.stringify({ apiVersion: '0.25.0', data: BULK_ITEMS }));
      return;
    }
    let m = url.match(/^\/v2\/items\/(.+)$/);
    if (m) {
      const slug = m[1];
      if (slug === SET.slug) {
        res.end(JSON.stringify({ data: { setParts: PARTS.map((p) => p.uid) } }));
      } else {
        res.end(JSON.stringify({ data: {} }));
      }
      return;
    }
    m = url.match(/^\/v2\/item\/(.+)$/);
    if (m) {
      const uid = m[1];
      const part = PARTS.find((p) => p.uid === uid);
      if (part) res.end(JSON.stringify({ data: part }));
      else {
        res.statusCode = 404;
        res.end('{}');
      }
      return;
    }
    m = url.match(/^\/v2\/orders\/item\/(.+)$/);
    if (m) {
      const slug = m[1];
      res.end(JSON.stringify({ data: ORDERS[slug as keyof typeof ORDERS] ?? [] }));
      return;
    }
    m = url.match(/^\/v1\/items\/(.+)\/statistics$/);
    if (m) {
      res.end(JSON.stringify({ payload: { statistics_closed: { '48hours': [{ volume: STAT_VOLUME }] } } }));
      return;
    }
    console.log('[stub] 404', url);
    res.statusCode = 404;
    res.end('{}');
  }
});

const port = Number(process.env.STUB_PORT) || 46441;
server.listen(port, '127.0.0.1', () => {
  console.log(`[stub] listening on http://127.0.0.1:${port}`);
});
