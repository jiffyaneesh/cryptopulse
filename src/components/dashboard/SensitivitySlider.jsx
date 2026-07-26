/**
 * components/dashboard/SensitivitySlider.jsx
 * ────────────────────────────────────────────
 * Live anomaly detection sensitivity slider.
 *
 * Allows users to tune the anomaly threshold in real time without restarting
 * the backend. Changes are debounced (300ms) before being POSTed to
 * POST /api/config to avoid flooding the API on every slider move.
 *
 * Threshold semantics (shown as tooltip):
 *   - HalfSpaceTrees: 0.0 (flag everything) → 1.0 (flag nothing). [0.5–0.95 useful range]
 *   - Z-Score:        0.5σ (very sensitive) → 5.0σ (very lenient). [2.0–4.0 useful range]
 *
 * @module components/dashboard/SensitivitySlider
 */

import React, { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import axios from "axios";
import GlassCard from "../ui/GlassCard";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

/** Debounce delay before sending config update to backend. */
const DEBOUNCE_MS = 300;

/**
 * Get human-readable sensitivity label from threshold value and model type.
 *
 * @param {number} threshold - Current threshold value.
 * @param {string} model     - "halftrees" or "zscore".
 * @returns {{ label: string, color: string }}
 */
function getSensitivityLabel(threshold, model) {
  if (model === "halftrees") {
    if (threshold < 0.5) return { label: "Very High", color: "var(--color-anomaly)" };
    if (threshold < 0.65) return { label: "High", color: "hsl(20, 100%, 55%)" };
    if (threshold < 0.80) return { label: "Medium", color: "var(--color-warning)" };
    if (threshold < 0.90) return { label: "Low", color: "var(--color-normal)" };
    return { label: "Very Low", color: "var(--color-normal-dim)" };
  } else {
    if (threshold < 1.5) return { label: "Very High", color: "var(--color-anomaly)" };
    if (threshold < 2.5) return { label: "High", color: "hsl(20, 100%, 55%)" };
    if (threshold < 3.5) return { label: "Medium", color: "var(--color-warning)" };
    if (threshold < 4.5) return { label: "Low", color: "var(--color-normal)" };
    return { label: "Very Low", color: "var(--color-normal-dim)" };
  }
}

/**
 * SensitivitySlider — Debounced threshold control for anomaly detection.
 *
 * @param {object} props
 * @param {number} props.initialThreshold - Starting threshold value from stats.
 * @param {string} props.modelType        - Current model type ("halftrees"|"zscore").
 * @param {Function} [props.onApplied]    - Called with new threshold after API success.
 * @returns {React.ReactElement}
 */
function SensitivitySlider({ initialThreshold, modelType = "halftrees", onApplied }) {
  const isHST = modelType === "halftrees";
  const min = isHST ? 0.3 : 0.5;
  const max = isHST ? 0.99 : 5.0;
  const step = isHST ? 0.01 : 0.1;

  const [value, setValue] = useState(initialThreshold ?? (isHST ? 0.75 : 3.0));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const debounceRef = useRef(null);

  // Sync value when model type or initial threshold changes
  useEffect(() => {
    if (initialThreshold != null) setValue(initialThreshold);
  }, [initialThreshold, modelType]);

  /**
   * Handle slider input — updates local state immediately for responsive UX,
   * then debounces the API call to avoid flooding on continuous drag.
   *
   * @param {React.ChangeEvent<HTMLInputElement>} e
   */
  function handleChange(e) {
    const newValue = parseFloat(e.target.value);
    setValue(newValue);

    // Cancel any pending debounced API call
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      setSaving(true);
      setSaved(false);
      try {
        await axios.post(`${API_URL}/api/config`, { threshold: newValue });
        setSaved(true);
        onApplied?.(newValue);
        // Clear "Saved" indicator after 1.5s
        setTimeout(() => setSaved(false), 1500);
      } catch (err) {
        console.error("[SensitivitySlider] Failed to update threshold:", err);
      } finally {
        setSaving(false);
      }
    }, DEBOUNCE_MS);
  }

  // Cleanup debounce timer on unmount
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const { label, color } = getSensitivityLabel(value, modelType);

  // Compute fill percentage for the slider track gradient
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <GlassCard title="Sensitivity" className="sensitivity-card" accentColor="var(--accent-purple)">
      <div className="sensitivity-slider">
        {/* Header: sensitivity label + save indicator */}
        <div className="sensitivity-slider__header">
          <motion.span
            key={label}
            className="sensitivity-slider__label font-semibold text-sm"
            style={{ color }}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            {label} Sensitivity
          </motion.span>
          <span className="sensitivity-slider__status text-xs text-muted">
            {saving ? "Applying…" : saved ? "✓ Applied" : ""}
          </span>
        </div>

        {/* Threshold value display */}
        <div className="sensitivity-slider__value-row">
          <span className="text-xs text-muted">
            {isHST ? "Score threshold" : "σ threshold"}
          </span>
          <span className="font-mono font-semibold text-accent">{value.toFixed(2)}</span>
        </div>

        {/* Range input with gradient track */}
        <div className="sensitivity-slider__track-wrapper">
          <input
            type="range"
            id="sensitivity-range"
            className="sensitivity-slider__input"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={handleChange}
            aria-label="Anomaly detection sensitivity"
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={value}
            style={{
              // Dynamic gradient: cyan fill up to thumb, dark after
              background: `linear-gradient(to right,
                var(--accent-cyan) 0%,
                var(--accent-cyan) ${pct}%,
                hsla(220, 20%, 30%, 0.5) ${pct}%,
                hsla(220, 20%, 30%, 0.5) 100%
              )`,
            }}
          />
        </div>

        {/* Min/Max labels */}
        <div className="sensitivity-slider__range-labels">
          <span className="text-xs text-muted">
            {isHST ? "Low (0.3)" : "High (0.5σ)"}
          </span>
          <span className="text-xs text-muted">
            {isHST ? "High (0.99)" : "Low (5.0σ)"}
          </span>
        </div>

        {/* Explanation text */}
        <p className="sensitivity-slider__hint text-xs text-muted">
          {isHST
            ? "Lower score → flag more ticks as anomalies."
            : "Lower σ → flag more ticks as anomalies."}
        </p>
      </div>
    </GlassCard>
  );
}

export default SensitivitySlider;
