/**
 * pages/Dashboard.jsx
 * ────────────────────
 * Main terminal layout component for CryptoPulse anomaly detection.
 */

import React, { useState, useEffect, useCallback } from "react";
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
          <PanelFrame title="DIAGNOSTICS" accentTitle="// HEALTH">
            <div style={{ padding: "var(--sp-3)", fontSize: "0.65rem", display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
              <div className="flex justify-between">
                <span className="text-muted">LATENCY:</span>
                <span className="text-profit font-bold">~12ms</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">WEBSOCKET:</span>
                <span className="text-profit font-bold">CONNECTED</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">MEMORY:</span>
                <span className="text-primary font-bold">14.2MB</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">BUFFER:</span>
                <span className="text-primary font-bold">200 Ticks</span>
              </div>
            </div>
          </PanelFrame>
        </div>
      </div>
    </div>
  );
}

export default Dashboard;
