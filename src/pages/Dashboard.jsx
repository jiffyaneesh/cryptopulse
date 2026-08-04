/**
 * pages/Dashboard.jsx
 * ────────────────────
 * Main terminal layout component for CryptoPulse anomaly detection.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import axios from "axios";

import Navbar from "../components/layout/Navbar";
import TickerBar from "../components/terminal/TickerBar";
import MarketStructure from "../components/terminal/MarketStructure";
import ConfidenceHeat from "../components/terminal/ConfidenceHeat";
import TradeLog from "../components/terminal/TradeLog";
import OpenPositions from "../components/terminal/OpenPositions";
import LiveChart from "../components/dashboard/LiveChart";
import SensitivitySlider from "../components/dashboard/SensitivitySlider";
import PanelFrame from "../components/layout/PanelFrame";
import Tooltip from "../components/ui/Tooltip";
import useWebSocket from "../hooks/useWebSocket";
import useStats from "../hooks/useStats";
import useTickStore from "../store/tickStore";

import "../styles/terminal_components.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

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

/** Measures time from last addTick call to estimate feed latency */
function useFeedLatency() {
  const lastTickTime = useRef(null);
  const [latencyMs, setLatencyMs] = useState(null);

  useEffect(() => {
    return useTickStore.subscribe(
      (state) => state.latestByCoins,
      () => {
        const now = Date.now();
        if (lastTickTime.current) {
          setLatencyMs(now - lastTickTime.current);
        }
        lastTickTime.current = now;
      }
    );
  }, []);

  return latencyMs;
}

function DiagnosticsPanel({ stats, activeCoin }) {
  const wsStatus       = useTickStore((state) => state.wsStatus);
  const reconnectCount = useTickStore((state) => state.reconnectCount);
  const tickHistory    = useTickStore((state) => state.tickHistory);
  const latencyMs      = useFeedLatency();

  // Total ticks buffered across all coins
  const totalBuffered = Object.values(tickHistory).reduce((sum, arr) => sum + arr.length, 0);

  // Anomaly rate
  const anomalyRate = stats?.anomaly_rate_pct != null
    ? `${stats.anomaly_rate_pct}%`
    : "---";

  // WS status display
  const wsColor = {
    connected:    "var(--color-profit)",
    connecting:   "var(--color-warning)",
    reconnecting: "var(--color-warning)",
    disconnected: "var(--color-loss)",
  }[wsStatus] || "var(--text-muted)";

  const wsLabel = wsStatus === "reconnecting"
    ? `RECONNECTING #${reconnectCount}`
    : wsStatus.toUpperCase();

  const rows = [
    {
      label: "WEBSOCKET",
      value: wsLabel,
      valueStyle: { color: wsColor, fontWeight: "bold" },
      tooltip: "Live WebSocket connection to the backend scoring worker.",
    },
    {
      label: "FEED LATENCY",
      value: latencyMs ? `~${latencyMs}ms` : "---",
      valueStyle: { color: latencyMs && latencyMs < 2000 ? "var(--color-profit)" : "var(--color-warning)", fontWeight: "bold" },
      tooltip: "Approximate time between ticks arriving. Backend polls ~every 10s.",
    },
    {
      label: "TICK BUFFER",
      value: `${totalBuffered} ticks`,
      valueStyle: { color: "var(--text-primary)", fontWeight: "bold" },
      tooltip: "Total ticks buffered in memory across all tracked coins (max 500/coin).",
    },
    {
      label: "ANOMALY RATE",
      value: anomalyRate,
      valueStyle: { color: "var(--color-warning)", fontWeight: "bold" },
      tooltip: "Percentage of all ticks flagged as anomalies since session start.",
    },
    {
      label: "ACTIVE COINS",
      value: stats?.tracked_coins?.length ?? DEFAULT_COINS.length,
      valueStyle: { color: "var(--text-primary)" },
      tooltip: "Number of coins currently tracked and scored.",
    },
    {
      label: "THROUGHPUT",
      value: stats?.throughput_per_minute != null
        ? `${stats.throughput_per_minute.toFixed(1)}/min`
        : "---",
      valueStyle: { color: "var(--text-primary)" },
      tooltip: "Ticks processed per minute by the scoring worker.",
    },
  ];

  return (
    <PanelFrame title="DIAGNOSTICS" accentTitle="// HEALTH">
      <div style={{ padding: "var(--sp-3)", fontSize: "0.65rem", display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between" style={{ alignItems: "center" }}>
            <Tooltip text={row.tooltip} position="top" maxWidth="220px">
              <span className="text-muted" style={{ cursor: "help", borderBottom: "1px dashed #333" }}>
                {row.label} ⓘ
              </span>
            </Tooltip>
            <span style={row.valueStyle}>{row.value}</span>
          </div>
        ))}
      </div>
    </PanelFrame>
  );
}

function Dashboard() {
  const [activeCoin, setActiveCoin] = useState("bitcoin");
  const [currentModel, setCurrentModel] = useState("halftrees");
  const [currentThreshold, setCurrentThreshold] = useState(0.99);

  useWebSocket();
  const { stats } = useStats();

  useEffect(() => {
    if (stats) {
      setCurrentModel(stats.current_model);
      setCurrentThreshold(stats.current_threshold);
    }
  }, [stats?.current_model, stats?.current_threshold]);

  const handleCoinChange = useCallback(async (coinId) => {
    setActiveCoin(coinId);

    const existing = useTickStore.getState().tickHistory[coinId];
    if (existing && existing.length > 0) return;

    try {
      const response = await axios.get(`${API_URL}/api/history`, {
        params: { coin_id: coinId, limit: 200 },
      });
      useTickStore.getState().loadHistory(coinId, response.data.ticks);
    } catch (err) {
      console.warn(`[Dashboard] Could not load history for ${coinId}:`, err.message);
    }
  }, []);

  useEffect(() => {
    handleCoinChange("bitcoin");
  }, [handleCoinChange]);

  const trackedCoins = stats?.tracked_coins || DEFAULT_COINS;

  return (
    <div className="terminal-container" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div className="scanline-overlay" />
      <Navbar
        currentModel={currentModel}
        onModelChange={(model) => setCurrentModel(model)}
      />
      <div className="terminal-grid" style={{ flex: 1 }}>
        {/* Ticker Bar (Top Row) */}
        <div className="terminal-grid__ticker">
          <TickerBar
            coins={trackedCoins}
            activeCoin={activeCoin}
            onSelectCoin={handleCoinChange}
          />
        </div>

        {/* Left Sidebar — Market Structure */}
        <div className="terminal-grid__left">
          <MarketStructure activeCoin={activeCoin} stats={stats} />
        </div>

        {/* Main Price Chart (Center) */}
        <div className="terminal-grid__chart">
          <PanelFrame
            title={`LIVE TELEMETRY // ${activeCoin.toUpperCase()}`}
            accentTitle="[60FPS CANVAS]"
            noPadding
          >
            <LiveChart coinId={activeCoin} className="h-full w-full" />
          </PanelFrame>
        </div>

        {/* Right Sidebar — Confidence & Model Controls */}
        <div className="terminal-grid__right" style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ConfidenceHeat activeCoin={activeCoin} />
          </div>
          <div style={{ height: "140px" }}>
            <SensitivitySlider
              initialThreshold={currentThreshold}
              modelType={currentModel}
              onApplied={(t) => setCurrentThreshold(t)}
            />
          </div>
        </div>

        {/* Bottom Left Panel — Open Positions */}
        <div className="terminal-grid__bottom1">
          <OpenPositions activeCoin={activeCoin} />
        </div>

        {/* Bottom Center Panel — Trade Log */}
        <div className="terminal-grid__bottom2">
          <TradeLog activeCoin={activeCoin} />
        </div>

        {/* Bottom Right Panel — System Diagnostics */}
        <div className="terminal-grid__bottom3">
          <DiagnosticsPanel stats={stats} activeCoin={activeCoin} />
        </div>
      </div>
    </div>
  );
}

export default Dashboard;
