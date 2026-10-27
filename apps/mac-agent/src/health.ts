import http from 'node:http';

/**
 * Local health endpoint, bound to 127.0.0.1 only. Rejects non-loopback peers and
 * foreign Host headers (DNS-rebinding protection). Exposes no secrets or output.
 */
export function startHealthServer(
  port: number,
  status: () => Record<string, unknown>,
): http.Server | null {
  if (port === 0) return null;
  const server = http.createServer((req, res) => {
    const peer = req.socket.remoteAddress ?? '';
    const host = (req.headers.host ?? '').toLowerCase();
    const okPeer = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    const okHost = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
    if (!okPeer || !okHost || req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(status()));
  });
  server.on('error', () => undefined); // port in use: health is optional
  server.listen(port, '127.0.0.1');
  return server;
}
