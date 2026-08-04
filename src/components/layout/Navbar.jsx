/**
 * components/layout/Navbar.jsx
 * ────────────────────────────
 * Terminal top controls sub-header.
 */

import React, { useState } from "react";
import axios from "axios";
import ConnectionStatus from "./ConnectionStatus";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

function Navbar({ currentModel = "halftrees", onModelChange }) {
  const [switching, setSwitching] = useState(false);

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

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "var(--sp-2) var(--sp-4)",
        background: "#080808",
        borderBottom: "1px solid var(--border-color)",
        fontFamily: "var(--font-mono)",
        fontSize: "0.7rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)" }}>
        <span style={{ fontWeight: "700", color: "var(--accent)", letterSpacing: "0.1em" }}>
          CRYPTOPULSE // ML-TERMINAL
        </span>
        <span className="text-muted">|</span>
        <div className="model-selector">
          <label htmlFor="model-select" className="text-muted" style={{ marginRight: "var(--sp-2)" }}>
            MODEL:
          </label>
          <select
            id="model-select"
            className="model-selector__select"
            value={currentModel}
            onChange={handleModelChange}
            disabled={switching}
            style={{
              background: "#040404",
              color: "var(--accent)",
              border: "1px solid var(--border-color)",
              padding: "2px 6px",
              fontSize: "0.65rem",
              fontFamily: "var(--font-mono)",
              outline: "none",
            }}
          >
            <option value="halftrees">HalfSpaceTrees (Quantile)</option>
            <option value="zscore">Rolling Z-Score (EWMA)</option>
          </select>
          {switching && <span className="text-muted" style={{ marginLeft: "var(--sp-2)" }}>[SWITCHING...]</span>}
        </div>
      </div>

      <ConnectionStatus />
    </div>
  );
}

export default Navbar;
