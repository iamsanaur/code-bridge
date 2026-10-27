import { loadEnv } from './env.js';
import { runRelay } from './run.js';

const env = loadEnv();
const relay = await runRelay(env, (m) => console.log(m));

const shutdown = async (signal: string) => {
  relay.app.log.info({ signal }, 'shutting down');
  await relay.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
