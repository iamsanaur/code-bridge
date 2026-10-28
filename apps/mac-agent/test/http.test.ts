import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { apiRequest, ApiError } from '../src/http.js';
import { waitForRelay } from '../src/pair.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(null)));
  server = undefined;
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('talking to something that is not the relay', () => {
  it('explains a web page instead of failing with a JSON parse error', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(530, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body>Tunnel error</body></html>');
    });
    const err = await apiRequest(url, 'GET', '/v1/relay/info').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('not_the_api');
    expect((err as ApiError).message).toMatch(/web page \(HTTP 530\)/);
    expect((err as ApiError).message).not.toMatch(/Unexpected token/);
  });

  it('still reports normal API errors with their own message', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'unauthorized', message: 'nope' }));
    });
    await expect(apiRequest(url, 'GET', '/x')).rejects.toMatchObject({
      code: 'unauthorized',
      message: 'nope',
    });
  });
});

describe('waiting for a new tunnel address', () => {
  const quiet = { print: () => undefined };
  const instant = async () => undefined;

  it('retries through error pages until the relay answers', async () => {
    let calls = 0;
    const url = await serve((_req, res) => {
      calls++;
      if (calls < 3) {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<!doctype html><p>not yet</p>');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'codebridge-relay', mode: 'personal' }));
    });
    await waitForRelay(url, quiet, instant);
    expect(calls).toBe(3);
  });

  it('gives up with the last problem it saw', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<!doctype html><p>someone else</p>');
    });
    await expect(waitForRelay(url, quiet, instant, 3)).rejects.toThrow(/web page \(HTTP 404\)/);
  });

  it('rejects a server that answers JSON but is not the relay', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'something-else' }));
    });
    await expect(waitForRelay(url, quiet, instant, 2)).rejects.toThrow(/not a CodeBridge relay/);
  });
});
