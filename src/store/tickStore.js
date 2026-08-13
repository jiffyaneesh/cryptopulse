/**
 * store/tickStore.js
 * ──────────────────
 * Zustand store for real-time WebSocket tick state.
 *
 * Why Zustand over React Context:
 *   React Context re-renders ALL consumers when the context value changes.
 *   At 1 tick/second × 8 coins, Context would cause 8 re-renders/second
 *   throughout the component tree — causing frame drops. Zustand uses
 *   shallow equality by default: components only re-render when their
 *   specific subscribed slice changes.
 *
 *   Additionally, the LiveChart component uses useTickStore.subscribe()
 *   (not useTickStore hook) to directly update the Canvas without triggering
 *   any React re-render at all — critical for 60fps chart performance.
 *
 * Responsibilities:
 *   - Store tick history per coin (capped at MAX_HISTORY_PER_COIN).
 *   - Track the latest tick for each coin.
 *   - Track anomaly counts per coin (for badge display in CoinSelector).
 *   - Track WebSocket connection status.
 *
 * NOT responsible for:
 *   - WebSocket connection management (see hooks/useWebSocket.js).
 *   - API calls or data formatting (see utils/formatters.js).
 *
 * @module store/tickStore
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

/**
 * Maximum number of ticks stored per coin in tickHistory.
 * Prevents unbounded memory growth for long-running sessions.
 * 500 ticks × 10s/tick = ~83 minutes of history per coin.
 */
const MAX_HISTORY_PER_COIN = 500;

/**
 * @typedef {Object} ScoredTick
 * @property {string}  coin_id          - CoinGecko coin identifier.
 * @property {string}  symbol           - Ticker symbol (e.g., "BTC").
 * @property {string}  name             - Human-readable name.
 * @property {number}  price_usd        - Current price in USD.
 * @property {number}  volume_24h       - 24h quote volume in USD.
 * @property {number}  price_change_24h - 24h price change percentage.
 * @property {number}  anomaly_score    - Normalised score ∈ [0, 1] (HST) or z-score.
 * @property {boolean} is_anomaly       - True when score exceeds threshold.
 * @property {string}  model_type       - "zscore" or "halftrees".
 * @property {number}  threshold        - Active threshold when scored.
 * @property {string}  polled_at        - ISO 8601 UTC timestamp.
 * @property {string}  scored_at        - ISO 8601 UTC timestamp.
 */

// subscribeWithSelector is REQUIRED for the two-argument
// subscribe(selector, callback) form used by LiveChart. Zustand v5's plain
// subscribe only accepts a single (state, prevState) listener — passing a
// selector without this middleware silently never invokes the callback.
const useTickStore = create(subscribeWithSelector((set, get) => ({
  /**
   * Tick history keyed by coin_id.
   * Each entry is an array of ScoredTick, oldest-first, capped at MAX_HISTORY_PER_COIN.
   * @type {Object.<string, ScoredTick[]>}
   */
  tickHistory: {},

  /**
   * Most recent scored tick for each coin.
   * Components that only need the latest price read this instead of tickHistory
   * to avoid re-rendering on every tick for coins they don't track.
   * @type {Object.<string, ScoredTick>}
   */
  latestByCoins: {},

  /**
   * Total anomaly count per coin (lifetime of the session).
   * Used to display red badge counts in the CoinSelector.
   * @type {Object.<string, number>}
   */
  anomalyCounts: {},

  /**
   * WebSocket connection state.
   * @type {"connecting"|"connected"|"reconnecting"|"disconnected"}
   */
  wsStatus: "connecting",

  /** @type {number} Number of reconnection attempts since last successful connect. */
  reconnectCount: 0,

  /**
   * Append a new scored tick to history and update derived state.
   *
   * Called by useWebSocket.js on every incoming WS message.
   * Trims tickHistory to MAX_HISTORY_PER_COIN to prevent memory growth.
   * Increments anomalyCounts if tick.is_anomaly is true.
   *
   * Performance note — targeted key update vs full spread:
   *   The naive pattern `{ ...state.tickHistory, [coin_id]: updated }` creates
   *   a new object with new references for EVERY coin on EVERY tick, even coins
   *   whose data did not change. With 8 coins at 6 ticks/min that is 48
   *   unnecessary object allocations per minute. Instead we update only the
   *   three keys that changed (tickHistory[coin_id], latestByCoins[coin_id],
   *   anomalyCounts[coin_id]) while reusing the parent map references for all
   *   other coins. Zustand's subscribeWithSelector() then only notifies
   *   selectors whose returned slice actually changed.
   *
   * @param {ScoredTick} tick - The scored tick received from the WebSocket.
   */
  addTick: (tick) =>
    set((state) => {
      const { coin_id } = tick;

      // Existing history for this coin — default to empty array
      const existing = state.tickHistory[coin_id] || [];

      // Append and trim: drop the oldest entry when at cap to stay O(1)
      const updated =
        existing.length >= MAX_HISTORY_PER_COIN
          ? [...existing.slice(1), tick]
          : [...existing, tick];

      // Increment anomaly count only when this tick is flagged
      const prevCount = state.anomalyCounts[coin_id] || 0;
      const newCount = tick.is_anomaly ? prevCount + 1 : prevCount;

      // Build new state objects only for the coin that changed.
      // All other coin entries keep the same reference — Zustand's shallow
      // equality check will skip re-renders for selectors that don't touch
      // this coin.
      const nextTickHistory = { ...state.tickHistory };
      nextTickHistory[coin_id] = updated;

      const nextLatestByCoins = { ...state.latestByCoins };
      nextLatestByCoins[coin_id] = tick;

      const nextAnomalyCounts = { ...state.anomalyCounts };
      nextAnomalyCounts[coin_id] = newCount;

      return {
        tickHistory: nextTickHistory,
        latestByCoins: nextLatestByCoins,
        anomalyCounts: nextAnomalyCounts,
      };
    }),

  /**
   * Bulk-load historical ticks for a coin (from GET /api/history).
   *
   * Called when the user switches coins — pre-populates the chart with
   * historical data before the next live WS tick arrives.
   *
   * The API now returns ticks oldest-first (ORDER BY polled_at ASC), so no
   * reversal is needed here. We just cap at MAX_HISTORY_PER_COIN.
   *
   * @param {string}      coin_id - Coin to load history for.
   * @param {ScoredTick[]} ticks  - Array of historical ticks (oldest-first from API).
   */
  loadHistory: (coin_id, ticks) =>
    set((state) => ({
      tickHistory: {
        ...state.tickHistory,
        [coin_id]: ticks.slice(-MAX_HISTORY_PER_COIN),
      },
    })),

  /**
   * Update WebSocket connection status.
   *
   * @param {"connecting"|"connected"|"reconnecting"|"disconnected"} status
   * @param {number} [reconnectCount=0] - Current reconnection attempt count.
   */
  setWsStatus: (status, reconnectCount = 0) =>
    set({ wsStatus: status, reconnectCount }),

  /**
   * Reset anomaly counts for a specific coin.
   * Called when the user manually clears alerts.
   *
   * @param {string} coin_id - Coin ID to reset.
   */
  resetAnomalyCount: (coin_id) =>
    set((state) => ({
      anomalyCounts: { ...state.anomalyCounts, [coin_id]: 0 },
    })),
})));

export default useTickStore;
