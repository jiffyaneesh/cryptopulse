/**
 * components/layout/Navbar.jsx
 * ────────────────────────────
 * Top navigation bar for the CryptoPulse dashboard.
 *
 * Contains:
 *   - Project logo/branding with animated pulse indicator.
 *   - Model selector dropdown (Z-Score ↔ HalfSpaceTrees).
 *   - ConnectionStatus badge (right-aligned).
 *
 * The model selector calls POST /api/config when changed and triggers
 * a scorer registry reset on the backend.
 *
 * @module components/layout/Navbar
 */

import React, { useState } from "react";
import { motion } from "framer-motion";
import axios from "axios";
import ConnectionStatus from "./ConnectionStatus";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

/**
 * Navbar — Top navigation bar with branding and controls.
 *
 * @param {object} props
 * @param {string} props.currentModel         - Active model type ("zscore"|"halftrees").
 * @param {Function} props.onModelChange       - Callback when model is changed.
 * @returns {React.ReactElement}
 */
function Navbar({ currentModel = "halftrees", onModelChange }) {
  const [switching, setSwitching] = useState(false);

  /**
   * Handle model type change from the selector dropdown.
   * POSTs to /api/config to trigger a backend scorer registry reset.
   *
   * @param {React.ChangeEvent<HTMLSelectElement>} e - Change event.
   */
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
    <nav className="navbar glass">
      {/* ── Branding ──────────────────────────────────────────────────────── */}
      <div className="navbar__brand">
        {/* Animated pulse orb — pulses when data is flowing */}
        <motion.div
          className="navbar__orb"
          animate={{
            boxShadow: [
              "0 0 8px var(--accent-cyan-glow)",
              "0 0 24px var(--accent-cyan-glow), 0 0 48px var(--accent-cyan-glow)",
              "0 0 8px var(--accent-cyan-glow)",
            ],
          }}
          transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
        />
        <div className="navbar__title-group">
          <h1 className="navbar__title gradient-cyan-purple">CryptoPulse</h1>
          <span className="navbar__subtitle text-xs text-muted">
            Real-Time Anomaly Detection
          </span>
        </div>
      </div>

      {/* ── Controls ──────────────────────────────────────────────────────── */}
      <div className="navbar__controls">
        {/* Model selector */}
        <div className="model-selector">
          <label
            htmlFor="model-select"
            className="model-selector__label text-xs text-muted"
          >
            Model
          </label>
          <select
            id="model-select"
            className="model-selector__select glass"
            value={currentModel}
            onChange={handleModelChange}
            disabled={switching}
          >
            <option value="halftrees">HalfSpaceTrees</option>
            <option value="zscore">Rolling Z-Score</option>
          </select>
          {switching && (
            <motion.span
              className="model-selector__loading text-xs text-muted"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              Switching…
            </motion.span>
          )}
        </div>

        <ConnectionStatus />
      </div>
    </nav>
  );
}

export default Navbar;
