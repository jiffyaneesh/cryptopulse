/**
 * components/dashboard/SensitivitySlider.jsx
 * ────────────────────────────────────────────
 * Live anomaly detection sensitivity slider.
 */

import React, { useState, useEffect, useRef } from "react";
import axios from "axios";
import PanelFrame from "../layout/PanelFrame";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const DEBOUNCE_MS = 300;

function getSensitivityLabel(threshold, model) {
  if (model === "halftrees") {
    if (threshold < 0.5) return { label: "VERY HIGH", color: "var(--accent)" };
    if (threshold < 0.65) return { label: "HIGH", color: "#ff5555" };
    if (threshold < 0.80) return { label: "MEDIUM", color: "var(--color-warning)" };
    if (threshold < 0.90) return { label: "LOW", color: "var(--color-profit)" };
    return { label: "VERY LOW", color: "var(--text-muted)" };
  } else {
    if (threshold < 1.5) return { label: "VERY HIGH", color: "var(--accent)" };
    if (threshold < 2.5) return { label: "HIGH", color: "#ff5555" };
    if (threshold < 3.5) return { label: "MEDIUM", color: "var(--color-warning)" };
    if (threshold < 4.5) return { label: "LOW", color: "var(--color-profit)" };
    return { label: "VERY LOW", color: "var(--text-muted)" };
  }
}

function SensitivitySlider({ initialThreshold, modelType = "halftrees", onApplied }) {
  const isHST = modelType === "halftrees";
  const min = isHST ? 0.3 : 0.5;
  const max = isHST ? 0.99 : 5.0;
  const step = isHST ? 0.01 : 0.1;

  const [value, setValue] = useState(initialThreshold ?? (isHST ? 0.75 : 3.0));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (initialThreshold != null) setValue(initialThreshold);
  }, [initialThreshold, modelType]);

  function handleChange(e) {
    const newValue = parseFloat(e.target.value);
    setValue(newValue);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      setSaving(true);
      setSaved(false);
      try {
        await axios.post(`${API_URL}/api/config`, { threshold: newValue });
        setSaved(true);
        onApplied?.(newValue);
        setTimeout(() => setSaved(false), 1500);
      } catch (err) {
        console.error("[SensitivitySlider] Failed to update threshold:", err);
      } finally {
        setSaving(false);
      }
    }, DEBOUNCE_MS);
  }

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const { label, color } = getSensitivityLabel(value, modelType);
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <PanelFrame title="SENSITIVITY CONTROL" accentTitle="// PARAMETER">
      <div className="sensitivity-slider" style={{ padding: "var(--sp-2) var(--sp-3)" }}>
        <div className="sensitivity-slider__header">
          <span
            className="sensitivity-slider__label font-bold text-xs"
            style={{ color }}
          >
            {label} SENSITIVITY
          </span>
          <span className="sensitivity-slider__status text-xs text-muted">
            {saving ? "SAVING..." : saved ? "✓ APPLIED" : ""}
          </span>
        </div>

        <div className="sensitivity-slider__value-row">
          <span className="text-xs text-muted">
            {isHST ? "QUANTILE THRESHOLD" : "SIGMA CUTOFF"}
          </span>
          <span className="font-mono font-bold text-accent">{value.toFixed(2)}</span>
        </div>

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
            style={{
              background: `linear-gradient(to right,
                var(--accent) 0%,
                var(--accent) ${pct}%,
                #1a1a1a ${pct}%,
                #1a1a1a 100%
              )`,
            }}
          />
        </div>

        <div className="sensitivity-slider__range-labels">
          <span className="text-xs text-muted">
            {isHST ? "0.30" : "0.50σ"}
          </span>
          <span className="text-xs text-muted">
            {isHST ? "0.99" : "5.00σ"}
          </span>
        </div>
      </div>
    </PanelFrame>
  );
}

export default SensitivitySlider;
