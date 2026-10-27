import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(0).max(65535).default(8080),
    DATABASE_URL: z
      .string()
      .regex(/^(postgres(ql)?|pglite):\/\//, 'must be a postgres:// or pglite:// URL'),
    PUBLIC_URL: z.url().default('http://localhost:8080'),
    /**
     * `multi`: email/password accounts (a shared, hosted relay).
     * `personal`: one owner, no accounts. The phone and the agent connect with OWNER_SECRET,
     * which travels in the QR code, so each person runs their own relay.
     */
    RELAY_MODE: z.enum(['multi', 'personal']).default('multi'),
    OWNER_SECRET: z.string().min(32, 'must be at least 32 characters').max(256).optional(),
    CREDENTIAL_ENCRYPTION_KEY: z
      .string()
      .optional()
      .refine(
        (v) => !v || Buffer.from(v, 'base64').length === 32,
        'must be 32 bytes, base64-encoded',
      ),
    CREDENTIAL_KEY_VERSION: z.coerce.number().int().positive().default(1),
    CORS_ORIGINS: z.string().default(''),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TRUST_PROXY: bool.default(false),
    /** Disable only in tests. */
    RATE_LIMIT_ENABLED: bool.default(true),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .default(15 * 60),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(3600)
      .default(30 * 24 * 3600),
    PAIRING_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
    COMMAND_ACK_TIMEOUT_MS: z.coerce.number().int().min(500).default(10_000),
    CLOUD_SESSIONS_ENABLED: bool.default(true),
    CLOUD_DEFAULT_MODEL: z.string().default('claude-opus-5-5'),
    CLOUD_DEFAULT_BUDGET_CENTS: z.coerce.number().int().min(10).max(100_000).default(500),
    CLOUD_MAX_CONCURRENT: z.coerce.number().int().min(1).max(20).default(2),
    CLOUD_MAX_SESSION_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .default(120),
  })
  .superRefine((env, ctx) => {
    if (env.RELAY_MODE === 'personal' && !env.OWNER_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['OWNER_SECRET'],
        message: 'required when RELAY_MODE=personal (at least 32 random characters)',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (!env.PUBLIC_URL.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_URL'],
          message: 'must use https:// in production',
        });
      }
      if (!env.CREDENTIAL_ENCRYPTION_KEY && env.CLOUD_SESSIONS_ENABLED) {
        ctx.addIssue({
          code: 'custom',
          path: ['CREDENTIAL_ENCRYPTION_KEY'],
          message: 'required in production when cloud sessions are enabled',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Print variable names and problems only – never the values.
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}
