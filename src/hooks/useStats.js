/**
 * hooks/useStats.js
 * ─────────────────
 * Polls the GET /api/stats endpoint at a fixed interval.
 *
 * The stats panel displays slowly-changing aggregate data (anomaly counts,
 * throughput, uptime) that doesn't need WebSocket delivery. Polling every
 * 5 seconds is sufficient and simpler than adding a second WS channel.
 *
 * Responsibilities:
 *   - Poll /api/stats every POLL_INTERVAL_MS milliseconds.
 *   - Return { stats, loading, error } for consumer components.
 *   - Clean up the interval on unmount.
 *
 * NOT responsible for:
 *   - Real-time tick data (see store/tickStore.js + hooks/useWebSocket.js).
 *
 * @module hooks/useStats
 */

import { useState, useEffect, useRef } from "react";
import axios from "axios";

/** Stats polling endpoint URL. */
const STATS_URL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api/stats`
  : "http://localhost:8000/api/stats";

/** How often to refresh stats from the backend (milliseconds). */
const POLL_INTERVAL_MS = 5000;

/**
 * @typedef {Object} StatsData
 * @property {number}            total_ticks_today      - All ticks received today.
 * @property {number}            anomalies_today        - Anomalous ticks today.
 * @property {number}            anomaly_rate_pct       - Anomaly rate as a percentage.
 * @property {number}            throughput_per_minute  - Average ticks/minute (last 5 min).
 * @property {number}            model_uptime_seconds   - Seconds since scorer started.
 * @property {number}            ws_client_count        - Connected WebSocket clients.
 * @property {string[]}          tracked_coins          - Currently tracked coin IDs.
 * @property {string}            current_model          - Active model type.
 * @property {number}            current_threshold      - Active anomaly threshold.
 * @property {Object.<string, number>} anomalies_by_coin - Per-coin anomaly counts.
 */

/**
 * Custom hook for polling dashboard statistics.
 *
 * @returns {{ stats: StatsData|null, loading: boolean, error: string|null }}
 */
function useStats() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);

  async function fetchStats() {
    try {
      const response = await axios.get(STATS_URL, { timeout: 4000 });
      setStats(response.data);
      setError(null);
    } catch (err) {
      // Don't clear existing stats on transient error — keep showing last known values.
      setError(err.message || "Failed to fetch stats");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Fetch immediately on mount, then poll on interval
    fetchStats();
    intervalRef.current = setInterval(fetchStats, POLL_INTERVAL_MS);

    return () => {
      // Cancel interval on unmount to prevent state updates on unmounted component
      clearInterval(intervalRef.current);
    };
  }, []);

  return { stats, loading, error };
}

export default useStats;
