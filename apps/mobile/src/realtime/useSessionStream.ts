import { useEffect, useRef, useState } from 'react';
import { useApp } from '../auth/AppContext';
import { SessionState } from './sessionState';

/**
 * Subscribes to a session's live events and exposes the reduced state.
 * Re-renders are batched to animation frames so fast output stays smooth.
 */
export function useSessionStream(sessionId: string) {
  const { realtime } = useApp();
  const stateRef = useRef<SessionState>(new SessionState());
  const [, setTick] = useState(0);

  useEffect(() => {
    const state = new SessionState();
    stateRef.current = state;
    let scheduled = false;
    const rerender = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        setTick((t) => t + 1);
      });
    };
    let resyncTimer: ReturnType<typeof setTimeout> | null = null;
    const off = realtime.onMessage((m) => {
      if (m.type === 'event' && m.sessionId === sessionId) {
        const r = state.apply(m);
        if (r === 'gap' && !resyncTimer) {
          // Ask for the missing events once things settle.
          resyncTimer = setTimeout(() => {
            resyncTimer = null;
            realtime.resync(sessionId, state.lastSeq);
          }, 300);
        }
        if (r === 'applied') rerender();
      } else if (m.type === 'replay.gap' && m.sessionId === sessionId) {
        state.resumeFrom(m.resumeFromSeq);
        rerender();
      }
    });
    const unsubscribe = realtime.subscribe(sessionId, () => state.lastSeq);
    setTick((t) => t + 1);
    return () => {
      off();
      unsubscribe();
      if (resyncTimer) clearTimeout(resyncTimer);
    };
  }, [realtime, sessionId]);

  return stateRef.current;
}
