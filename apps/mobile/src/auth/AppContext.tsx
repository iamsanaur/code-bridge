import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TokenPair } from '@codebridge/protocol';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { ApiClient, ApiError, type TokenStore } from '../api/client';
import { API_URL, wsUrl } from '../config';
import { secureStorage } from '../lib/secureStorage';
import { RealtimeClient } from '../realtime/socket';

const TOKEN_KEY = 'codebridge.tokens.v1';

export const secureTokenStore: TokenStore = {
  async load() {
    const raw = await secureStorage.get(TOKEN_KEY);
    try {
      return raw ? (JSON.parse(raw) as TokenPair) : null;
    } catch {
      return null;
    }
  },
  save: (t) => secureStorage.set(TOKEN_KEY, JSON.stringify(t)),
  clear: () => secureStorage.delete(TOKEN_KEY),
};

export interface User {
  id: string;
  email: string;
}

interface AppCtx {
  api: ApiClient;
  realtime: RealtimeClient;
  user: User | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  deleteAccount: (password: string) => Promise<void>;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}

export function AppProvider({
  children,
  api: injectedApi,
  realtime: injectedRt,
}: {
  children: ReactNode;
  api?: ApiClient;
  realtime?: RealtimeClient;
}) {
  const api = useMemo(() => injectedApi ?? new ApiClient(API_URL, secureTokenStore), [injectedApi]);
  const realtime = useMemo(
    () =>
      injectedRt ??
      new RealtimeClient({ url: wsUrl('/v1/client/ws'), getToken: () => api.freshAccessToken() }),
    [injectedRt, api],
  );
  const queryClient = useRef(
    new QueryClient({
      defaultOptions: {
        queries: {
          // Retry network/server errors only; 4xx responses are definitive.
          retry: (count, err) =>
            count < 2 && !(err instanceof ApiError && err.status > 0 && err.status < 500),
          staleTime: 5_000,
        },
      },
    }),
  ).current;
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const signedOutLocally = useCallback(() => {
    realtime.stop();
    queryClient.clear();
    setUser(null);
  }, [realtime, queryClient]);

  useEffect(() => {
    api.onSignedOut = signedOutLocally;
    let cancelled = false;
    (async () => {
      try {
        if (await api.restore()) {
          const me = await api.get<User>('/v1/me');
          if (!cancelled) setUser(me);
        }
      } catch {
        // Expired or unreachable: stay signed out (tokens are cleared on 401 refresh failure).
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, signedOutLocally]);

  useEffect(() => {
    if (!user) return;
    realtime.start();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') realtime.nudge();
    });
    return () => {
      sub.remove();
      realtime.stop();
    };
  }, [user, realtime]);

  const finishAuth = useCallback(
    async (res: { user: User; tokens: TokenPair }) => {
      await api.setTokens(res.tokens);
      setUser(res.user);
    },
    [api],
  );

  const value = useMemo<AppCtx>(
    () => ({
      api,
      realtime,
      user,
      ready,
      signIn: async (email, password) =>
        finishAuth(
          await api.request('POST', '/v1/auth/login', { body: { email, password }, auth: false }),
        ),
      register: async (email, password) =>
        finishAuth(
          await api.request('POST', '/v1/auth/register', {
            body: { email, password },
            auth: false,
          }),
        ),
      signOut: async () => {
        await api.post('/v1/auth/logout').catch(() => undefined);
        await api.clearTokens();
        signedOutLocally();
      },
      deleteAccount: async (password) => {
        await api.delete('/v1/me', { password });
        await api.clearTokens();
        signedOutLocally();
      },
    }),
    [api, realtime, user, ready, finishAuth, signedOutLocally],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </QueryClientProvider>
  );
}
