/**
 * pages/Dashboard.jsx
 * ────────────────────
 * Main live dashboard page for the CryptoPulse anomaly detection UI.
 *
 * Layout (responsive 2-column):
 *   ┌──────────────────────────────────────────────────────┐
 *   │ Navbar                                               │
 *   ├──────────────────────────────────────────────────────┤
 *   │ CoinSelector tabs                                    │
 *   ├────────────────────────────┬─────────────────────────┤
 *   │                            │ StatsPanel              │
 *   │   LiveChart (large)        ├─────────────────────────┤
 *   │                            │ SensitivitySlider       │
 *   └────────────────────────────┴─────────────────────────┘
 *
 * Responsibilities:
 *   - Mount useWebSocket hook (connects to backend WS, dispatches to store).
 *   - Manage activeCoin state and propagate to child components.
 *   - Load historical data when coin changes (pre-populates LiveChart).
 *   - Load initial model state from stats endpoint.
 *
 * NOT responsible for:
 *   - Direct WebSocket/API data handling (delegated to hooks and store).
 *   - Chart rendering (LiveChart.jsx).
 *   - Stats display (StatsPanel.jsx).
 *
 * @module pages/Dashboard
 */

import React, { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import axios from "axios";

import Navbar from "../components/layout/Navbar";
import CoinSelector from "../components/layout/CoinSelector";
import LiveChart from "../components/dashboard/LiveChart";
import StatsPanel from "../components/dashboard/StatsPanel";
import SensitivitySlider from "../components/dashboard/SensitivitySlider";
import useWebSocket from "../hooks/useWebSocket";
import useStats from "../hooks/useStats";
import useTickStore from "../store/tickStore";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

/** Default list of tracked coins (matches backend default settings). */
const DEFAULT_COINS = [
  "bitcoin",
  "ethereum",
  "binancecoin",
  "solana",
  "cardano",
  "ripple",
  "polkadot",
  "dogecoin",
];

/**
 * Dashboard — Main real-time anomaly detection dashboard page.
 *
 * @returns {React.ReactElement}
 */
function Dashboard() {
  const [activeCoin, setActiveCoin] = useState("bitcoin");
  const [currentModel, setCurrentModel] = useState("halftrees");
  const [currentThreshold, setCurrentThreshold] = useState(0.75);

  // Mount the WebSocket hook — connects once, dispatches ticks to Zustand store.
  // The return value is only used for dev/debugging; the store is the source of truth.
  useWebSocket();

  // Stats hook for getting current model/threshold state on initial load
  const { stats } = useStats();

  // Sync model and threshold from stats when they first load
  useEffect(() => {
    if (stats) {
      setCurrentModel(stats.current_model);
      setCurrentThreshold(stats.current_threshold);
    }
  }, [stats?.current_model, stats?.current_threshold]);

  /**
   * Load historical ticks when the user switches coins.
   *
   * Fetches from GET /api/history and loads into Zustand store so
   * LiveChart can pre-populate without waiting for the next WS tick.
   *
   * @param {string} coinId - The newly selected coin ID.
   */
  const handleCoinChange = useCallback(async (coinId) => {
    setActiveCoin(coinId);

    // Only fetch if we don't already have history for this coin
    const existing = useTickStore.getState().tickHistory[coinId];
    if (existing && existing.length > 0) return;

    try {
      const response = await axios.get(`${API_URL}/api/history`, {
        params: { coin_id: coinId, limit: 200 },
      });
      useTickStore.getState().loadHistory(coinId, response.data.ticks);
    } catch (err) {
      // History is optional — LiveChart shows "Waiting for first tick" otherwise
      console.warn(`[Dashboard] Could not load history for ${coinId}:`, err.message);
    }
  }, []);

  // Load history for the initial coin on mount
  useEffect(() => {
    handleCoinChange("bitcoin");
  }, [handleCoinChange]);

  return (
    <motion.div
      className="dashboard"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      {/* ── Top Navigation ────────────────────────────────────────────────── */}
      <Navbar
        currentModel={currentModel}
        onModelChange={(model) => setCurrentModel(model)}
      />

      {/* ── Coin Selection Tabs ───────────────────────────────────────────── */}
      <CoinSelector
        activeCoin={activeCoin}
        coins={stats?.tracked_coins || DEFAULT_COINS}
        onCoinChange={handleCoinChange}
      />

      {/* ── Main Content Grid ─────────────────────────────────────────────── */}
      <div className="dashboard__content">
        {/* Chart — takes up most horizontal space */}
        <motion.div
          className="dashboard__chart-col"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
        >
          <LiveChart coinId={activeCoin} className="dashboard__chart" />
        </motion.div>

        {/* Sidebar — stats and controls */}
        <motion.div
          className="dashboard__sidebar"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
        >
          <StatsPanel activeCoin={activeCoin} />
          <SensitivitySlider
            initialThreshold={currentThreshold}
            modelType={currentModel}
            onApplied={(t) => setCurrentThreshold(t)}
          />
        </motion.div>
      </div>
    </motion.div>
  );
}

export default Dashboard;
