/**
 * hooks/useWebSocket.js
 * ─────────────────────
 * Manages the WebSocket connection lifecycle to the FastAPI backend.
 *
 * Handles:
 *   - Initial connection on mount.
 *   - Automatic reconnection with exponential backoff (max 30s delay).
 *   - Dispatching incoming JSON tick frames to Zustand tickStore.
 *   - Cleanup on unmount (no zombie WS connections left open).
 *
 * Design decision — reconnect backoff:
 *   Simple reconnect loops can flood a recovering server. Exponential backoff
 *   (1s → 2s → 4s → 8s → 16s → 30s cap) gives the backend time to restart.
 *
 * NOT responsible for:
 *   - Parsing or validating tick data (trust the FastAPI response model).
 *   - Rendering or chart updates (see LiveChart.jsx).
 *
 * @module hooks/useWebSocket
 */

import { useEffect, useRef } from "react";
import useTickStore from "../store/tickStore";

/** WebSocket server URL. In production, replace with the Nginx-proxied URL. */
const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8000/ws/ticks";

/** Initial reconnect delay in milliseconds. */
const RECONNECT_BASE_MS = 1000;

/** Maximum reconnect delay cap in milliseconds. */
const RECONNECT_MAX_MS = 30_000;

/**
 * Custom hook that manages a persistent WebSocket connection.
 *
 * Mounts once (via useEffect with empty deps) and keeps the WS alive
 * with automatic reconnection. Dispatches tick frames to Zustand store.
 *
 * @returns {{ isConnected: boolean, reconnectCount: number }}
 */
function useWebSocket() {
  const wsRef = useRef(null);
  const reconnectCountRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const mountedRef = useRef(true);

  const { addTick, setWsStatus } = useTickStore.getState();

  useEffect(() => {
    mountedRef.current = true;
    connect();

    // Cleanup: close the WS and cancel any pending reconnect timer on unmount.
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) wsRef.current.close(1000, "Component unmounted");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Open a new WebSocket connection.
   *
   * Sets up onopen/onmessage/onerror/onclose handlers. On disconnect,
   * schedules a reconnect with exponential backoff.
   */
  function connect() {
    if (!mountedRef.current) return;

    setWsStatus("connecting", reconnectCountRef.current);
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      reconnectCountRef.current = 0;
      setWsStatus("connected", 0);
      useTickStore.getState().setWsStatus("connected", 0);
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const tick = JSON.parse(event.data);
        // Dispatch to Zustand store — subscribers (LiveChart) update directly
        useTickStore.getState().addTick(tick);
      } catch (err) {
        console.warn("[useWebSocket] Failed to parse tick:", err);
      }
    };

    ws.onerror = (err) => {
      console.warn("[useWebSocket] WebSocket error:", err);
    };

    ws.onclose = (event) => {
      if (!mountedRef.current) return;
      // Code 1000 = normal close (component unmount) — do not reconnect.
      if (event.code === 1000) return;

      reconnectCountRef.current += 1;
      setWsStatus("reconnecting", reconnectCountRef.current);

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped)
      const delay = Math.min(
        RECONNECT_BASE_MS * 2 ** (reconnectCountRef.current - 1),
        RECONNECT_MAX_MS
      );

      console.info(
        `[useWebSocket] Reconnecting in ${delay}ms (attempt ${reconnectCountRef.current})`
      );

      reconnectTimerRef.current = setTimeout(connect, delay);
    };
  }

  // Expose reactive status from the store
  const wsStatus = useTickStore((state) => state.wsStatus);
  const reconnectCount = useTickStore((state) => state.reconnectCount);

  return {
    isConnected: wsStatus === "connected",
    reconnectCount,
  };
}

export default useWebSocket;
