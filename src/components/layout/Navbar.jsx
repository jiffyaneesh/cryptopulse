/**
 * components/layout/Navbar.jsx
 * ────────────────────────────
 * Terminal top bar with model switcher, refresh, keyboard shortcuts hint.
 */

import React, { useState } from "react";
import axios from "axios";
import ConnectionStatus from "./ConnectionStatus";
import Tooltip from "../ui/Tooltip";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

const MODEL_DESCRIPTIONS = {
  halftrees: "HalfSpaceTrees (HST) — streaming anomaly detection using random half-space partitions. Best for non-stationary distributions.",
  zscore: "Rolling Z-Score with EWMA — measures how far a tick deviates from the recent mean in standard deviations. Fast and interpretable.",
};

const SHORTCUTS = [
  { key: "1–8", desc: "Select coin by position in ticker" },
  { key: "A", desc: "Toggle anomalies-only filter in Trade Log" },
  { key: "R", desc: "Refresh page / reset WebSocket" },
];

function Navbar({ currentModel = "halftrees", onModelChange }) {
  const [switching, setSwitching]         = useState(false);
  const [refreshing, setRefreshing]       = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  async function handleModelChange(e) {
    const newModel = e.target.value;
    if (newModel === currentModel) return;

    setSwitching(true);
    try {
      await axios.post(`${API_URL}/api/config`, { model_type: newModel });
      onModelChange?.(newModel);
    } catch (err) {
      console.error("[Navbar] Failed to switch model:", err);
    } finally {
      setSwitching(false);
    }
  }

  function handleRefresh() {
    setRefreshing(true);
    setTimeout(() => {
      window.location.reload();
    }, 200);
  }

  return (
    <div className="navbar">
      {/* LEFT: brand + model selector */}
      <div className="navbar__left">
        <Tooltip text="CryptoPulse ML Terminal — real-time anomaly detection on live crypto ticks." position="bottom">
          <span className="navbar__brand">
            CRYPTOPULSE // ML-TERMINAL
          </span>
        </Tooltip>

        <span className="text-muted navbar__sep">|</span>

        <div className="navbar__model-group">
          <Tooltip
            text={MODEL_DESCRIPTIONS[currentModel] || "Select anomaly detection model."}
            position="bottom"
            maxWidth="280px"
          >
            <label
              htmlFor="model-select"
              className="text-muted navbar__model-label"
              style={{ cursor: "help" }}
            >
              MODEL ⓘ
            </label>
          </Tooltip>
          <select
            id="model-select"
            className="navbar__model-select"
            value={currentModel}
            onChange={handleModelChange}
            disabled={switching}
          >
            <option value="halftrees">HalfSpaceTrees (Quantile)</option>
            <option value="zscore">Rolling Z-Score (EWMA)</option>
          </select>
          {switching && (
            <span className="text-muted navbar__model-status">[SWITCHING...]</span>
          )}
        </div>
      </div>

      {/* RIGHT: shortcuts toggle + refresh + connection */}
      <div className="navbar__right">
        {/* Keyboard shortcuts panel */}
        <div style={{ position: "relative" }}>
          <Tooltip text="Show keyboard shortcuts" position="bottom">
            <button
              className={`navbar-btn ${showShortcuts ? "navbar-btn--active" : ""}`}
              onClick={() => setShowShortcuts((s) => !s)}
              aria-label="Keyboard shortcuts"
            >
              ⌨ KEYS
            </button>
          </Tooltip>

          {showShortcuts && (
            <div className="shortcuts-panel">
              <div className="shortcuts-panel__title">KEYBOARD SHORTCUTS</div>
              {SHORTCUTS.map((sc) => (
                <div key={sc.key} className="shortcuts-panel__row">
                  <kbd className="shortcut-key">{sc.key}</kbd>
                  <span className="shortcuts-panel__desc">{sc.desc}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Refresh */}
        <Tooltip text="Reload the terminal and reset all state." position="bottom">
          <button
            className="navbar-btn"
            onClick={handleRefresh}
            disabled={refreshing}
            aria-label="Refresh terminal"
          >
            {refreshing ? "..." : "↺ REFRESH"}
          </button>
        </Tooltip>

        <ConnectionStatus />
      </div>
    </div>
  );
}

export default Navbar;
