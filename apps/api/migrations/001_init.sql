-- CodeBridge initial schema.
-- Secrets are never stored in plaintext: passwords are scrypt hashes, tokens are
-- SHA-256 hashes of high-entropy random values, and API keys are AES-256-GCM
-- ciphertext (see src/lib/secretBox.ts).

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per signed-in mobile app instance. Access + refresh tokens rotate together.
CREATE TABLE auth_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_hash         bytea NOT NULL UNIQUE,
  refresh_hash        bytea NOT NULL UNIQUE,
  -- The previous refresh token; presenting it again signals token theft and revokes the session.
  prev_refresh_hash   bytea UNIQUE,
  access_expires_at   timestamptz NOT NULL,
  refresh_expires_at  timestamptz NOT NULL,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz,
  revoked_reason      text
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

-- Paired Macs.
CREATE TABLE devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                text NOT NULL,
  secret_hash         bytea NOT NULL UNIQUE,
  -- Previous secret stays valid briefly after rotation so a crash mid-rotation can't brick the agent.
  prev_secret_hash    bytea UNIQUE,
  prev_secret_valid_until timestamptz,
  secret_rotated_at   timestamptz NOT NULL DEFAULT now(),
  hostname            text,
  platform            text,
  arch                text,
  agent_version       text,
  capabilities        jsonb,
  workspaces          jsonb NOT NULL DEFAULT '[]'::jsonb,
  presets             jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_seen_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz
);
CREATE INDEX devices_user_idx ON devices(user_id);

-- Device-authorization-grant style pairing (modelled on RFC 8628).
CREATE TABLE pairings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_code        text NOT NULL,
  -- Held only by the agent that started the pairing; required to collect the credential.
  poll_secret_hash bytea NOT NULL,
  device_name      text NOT NULL,
  hostname         text,
  platform         text,
  status           text NOT NULL CHECK (status IN ('pending', 'claimed', 'approved', 'denied', 'completed', 'expired')),
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  device_id        uuid REFERENCES devices(id) ON DELETE CASCADE,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  completed_at     timestamptz,
  failed_attempts  integer NOT NULL DEFAULT 0
);
-- A user code is only unique among live pairings.
CREATE UNIQUE INDEX pairings_live_code_idx ON pairings(user_code) WHERE status IN ('pending', 'claimed', 'approved');

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('local', 'cloud')),
  device_id           uuid REFERENCES devices(id) ON DELETE CASCADE,
  workspace_id        text,
  workspace_name      text,
  mode                text NOT NULL,
  title               text NOT NULL,
  status              text NOT NULL,
  exit_code           integer,
  usage               jsonb,
  last_seq            integer NOT NULL DEFAULT 0,
  provider_session_id text,
  environment_id      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  CHECK ((kind = 'local' AND device_id IS NOT NULL) OR (kind = 'cloud' AND device_id IS NULL))
);
CREATE INDEX sessions_user_idx ON sessions(user_id, created_at DESC);
CREATE INDEX sessions_device_idx ON sessions(device_id) WHERE device_id IS NOT NULL;

-- Idempotency for control commands: the same (user, command id) never executes twice.
CREATE TABLE commands (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   uuid REFERENCES devices(id) ON DELETE CASCADE,
  op          text NOT NULL,
  status      text NOT NULL CHECK (status IN ('pending', 'ok', 'error')),
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commands_created_idx ON commands(created_at);

-- Encrypted provider credentials (cloud sessions only; local keys live in the Mac's Keychain).
CREATE TABLE provider_credentials (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     text NOT NULL CHECK (provider IN ('anthropic')),
  ciphertext   bytea NOT NULL,
  iv           bytea NOT NULL,
  auth_tag     bytea NOT NULL,
  key_version  integer NOT NULL,
  hint         text NOT NULL, -- last 4 characters, for display only
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

-- Per-user managed-agents resources created by CodeBridge (agent + environment ids at Anthropic).
CREATE TABLE cloud_configs (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  agent_id           text,
  agent_version      integer,
  environment_id     text,
  model              text NOT NULL,
  networking         text NOT NULL CHECK (networking IN ('limited', 'unrestricted')),
  allowed_hosts      jsonb NOT NULL DEFAULT '[]'::jsonb,
  budget_cents       integer NOT NULL,
  max_concurrent     integer NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Security audit trail. Metadata is redacted before insert; never contains terminal output.
CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id   uuid REFERENCES devices(id) ON DELETE SET NULL,
  action      text NOT NULL,
  ip          text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_user_idx ON audit_events(user_id, created_at DESC);
