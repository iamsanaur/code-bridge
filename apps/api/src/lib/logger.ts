import { redactSecrets, redactValue } from '@codebridge/shared';
import type { FastifyServerOptions } from 'fastify';

/**
 * Pino options with two layers of redaction:
 * 1. Path-based redaction of headers/fields that carry credentials.
 * 2. A formatter that runs pattern-based secret redaction over every log record.
 */
export function loggerOptions(level: string): FastifyServerOptions['logger'] {
  return {
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.headers["sec-websocket-protocol"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.accessToken',
        '*.refreshToken',
        '*.apiKey',
        '*.deviceSecret',
        '*.pollSecret',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      log(obj) {
        return redactValue(obj) as Record<string, unknown>;
      },
    },
    hooks: {
      logMethod(args, method) {
        const redacted = args.map((a) => (typeof a === 'string' ? redactSecrets(a) : a));
        return method.apply(this, redacted as Parameters<typeof method>);
      },
    },
    serializers: {
      req(req) {
        // Never log query strings: they are not used for secrets, but strip them anyway.
        return { method: req.method, url: String(req.url).split('?')[0], remoteAddress: req.ip };
      },
    },
  };
}
