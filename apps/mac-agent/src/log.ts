import { redactSecrets, redactValue } from '@codebridge/shared';

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** JSON-lines logger to stderr with secret redaction on every record. Never logs terminal output. */
export function createLogger(level: 'info' | 'warn' | 'error' | 'silent' = 'info'): Logger {
  const order = { info: 0, warn: 1, error: 2, silent: 3 } as const;
  const write = (lvl: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    const rec = {
      time: new Date().toISOString(),
      level: lvl,
      msg: redactSecrets(msg),
      ...(meta ? (redactValue(meta) as object) : {}),
    };
    process.stderr.write(JSON.stringify(rec) + '\n');
  };
  return {
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  };
}
