/**
 * Secret redaction used by every logger and by anything that echoes text the
 * user did not author (process output summaries, error messages, audit metadata).
 *
 * Redaction is defence in depth: code paths are designed never to put secrets into
 * logs in the first place. These patterns catch accidents.
 */

const REDACTED = '[REDACTED]';

const PATTERNS: RegExp[] = [
  // Anthropic API keys and admin keys
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  // Generic "sk-..." style provider keys
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // CodeBridge credentials (access, refresh, device, pairing secrets)
  /\bcb[adrp]_[A-Za-z0-9_-]{16,}\b/g,
  // Bearer tokens in headers or text
  /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  // GitHub tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // AWS access key ids
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Slack tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  // PEM private keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // KEY=value assignments for secret-looking names (env dumps, .env files)
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"']+)/g,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(re, (match, prefix?: string) => {
      // Patterns with a capture group keep the prefix (e.g. "Bearer ", "API_KEY=").
      if (typeof prefix === 'string' && match.startsWith(prefix) && prefix.length < match.length) {
        return prefix + REDACTED;
      }
      return REDACTED;
    });
  }
  return out;
}

const SENSITIVE_KEYS =
  /^(password|pass|secret|token|accessToken|refreshToken|deviceSecret|pairingSecret|apiKey|api_key|authorization|cookie|x-api-key|ciphertext)$/i;

/** Deep-copies a value, redacting sensitive keys and secret-looking strings. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[Truncated]';
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}
