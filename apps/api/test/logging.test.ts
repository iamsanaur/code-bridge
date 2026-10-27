import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../src/lib/logger.js';

describe('log redaction', () => {
  it('never writes credentials to logs', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const app = Fastify({ logger: { ...(loggerOptions('info') as object), stream } });
    app.get('/x', async (req) => {
      req.log.info(
        {
          apiKey: 'sk-ant-api03-SECRETSECRETSECRET',
          nested: { note: 'token cba_ABCDEFGHIJKLMNOPQRSTUV' },
        },
        'got Bearer abcdefghijklmnopqrs',
      );
      req.log.warn('ANTHROPIC_API_KEY=sk-ant-zzzzzzzzzzzzzzzz leaked?');
      return { ok: true };
    });
    await app.inject({
      method: 'GET',
      url: '/x?token=cba_querysecretquerysecret',
      headers: { authorization: 'Bearer cba_headersecretheadersecret' },
    });
    await app.close();
    const all = lines.join('\n');
    expect(all).toContain('[REDACTED]');
    for (const secret of [
      'SECRETSECRETSECRET',
      'cba_ABCDEFGHIJKLMNOPQRSTUV',
      'abcdefghijklmnopqrs',
      'sk-ant-zzzz',
      'querysecret',
      'headersecret',
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});
