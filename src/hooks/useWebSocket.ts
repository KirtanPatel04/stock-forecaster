import { useEffect, useRef, useCallback } from 'react';
import type { WSMessage } from '../types';
import { API_ORIGIN } from '../api/client';

type MessageHandler = (msg: WSMessage) => void;

export function useWebSocket(ticker: string | null, onMessage: MessageHandler) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  const connect = useCallback((t: string) => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    const base = API_ORIGIN
      ? API_ORIGIN.replace(/^http/, 'ws')
      : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
    const ws = new WebSocket(`${base}/api/stocks/ws/${t}`);

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);
        handlerRef.current(msg);
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      // Reconnect after 3s if ticker is still set
      if (wsRef.current === ws) {
        setTimeout(() => {
          if (wsRef.current === ws) connect(t);
        }, 3000);
      }
    };

    ws.onerror = () => ws.close();
    wsRef.current = ws;
  }, []);

  useEffect(() => {
    if (!ticker) return;
    connect(ticker);
    return () => {
      if (wsRef.current) {
        const ws = wsRef.current;
        wsRef.current = null;
        ws.close();
      }
    };
  }, [ticker, connect]);

  return wsRef;
}
