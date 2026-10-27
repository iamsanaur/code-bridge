import Constants from 'expo-constants';

/**
 * API base URL. Set EXPO_PUBLIC_API_URL (or `extra.apiUrl` in app.json).
 * Production builds must use https; plain http is only accepted for local development hosts.
 */
function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  const fromConfig = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  const url = (fromEnv || fromConfig || 'http://localhost:8080').replace(/\/$/, '');
  return url;
}

export const API_URL = resolveApiUrl();

export function isInsecureApi(url = API_URL): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return false;
    const devHost =
      /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
        u.hostname,
      );
    return !devHost || !__DEV__;
  } catch {
    return true;
  }
}

export const wsUrl = (path: string) => API_URL.replace(/^http/, 'ws') + path;
