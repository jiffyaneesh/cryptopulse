/**
 * components/dashboard/SensitivitySlider.jsx
 * ────────────────────────────────────────────
 * Live anomaly detection sensitivity slider with preset buttons.
 *
 * Presets:
 *   AGGRESSIVE — low threshold, flags more anomalies (noisy but sensitive)
 *   BALANCED   — recommended default
 *   CONSERVATIVE — high threshold, only flags strong anomalies
 */

import React, { useState, useEffect, useRef } from "react";
import axios from "axios";
import PanelFrame from "../layout/PanelFrame";
import Tooltip from "../ui/Tooltip";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const DEBOUNCE_MS = 300;

// Preset configs per model type
const PRESETS = {
  halftrees: [
    {
      label: "AGGR",
      fullLabel: "AGGRESSIVE",
      value: 0.45,
      tooltip: "Flag most anomalies. High false-positive rate but catches everything.",
      color: "var(--accent)",
    },
    {
      label: "BAL",
      fullLabel: "BALANCED",
      value: 0.75,
      tooltip: "Recommended. Balances sensitivity vs noise.",
      color: "var(--color-warning)",
    },
    {
      label: "CONS",
      fullLabel: "CONSERVATIVE",
      value: 0.94,
      tooltip: "Only flag strong anomalies. Fewer alerts, higher confidence.",
      color: "var(--color-profit)",
    },
  ],
  zscore: [
    {
      label: "AGGR",
      fullLabel: "AGGRESSIVE",
      value: 1.5,
      tooltip: "Flag anything beyond 1.5σ. Very sensitive.",
      color: "var(--accent)",
    },
    {
      label: "BAL",
      fullLabel: "BALANCED",
      value: 3.0,
      tooltip: "Classic 3-sigma rule. Recommended default.",
      color: "var(--color-warning)",
    },
    {
      label: "CONS",
      fullLabel: "CONSERVATIVE",
      value: 4.5,
      tooltip: "Only flag 4.5σ+ events. Rare but high-confidence signals.",
      color: "var(--color-profit)",
    },
  ],
};

function getSensitivityLabel(threshold, model) {
  if (model === "halftrees") {
    if (threshold < 0.5)  return { label: "VERY HIGH", color: "var(--accent)" };
    if (threshold < 0.65) return { label: "HIGH",      color: "#ff5555" };
    if (threshold < 0.80) return { label: "MEDIUM",    color: "var(--color-warning)" };
    if (threshold < 0.90) return { label: "LOW",       color: "var(--color-profit)" };
    return                       { label: "VERY LOW",  color: "var(--text-muted)" };
  } else {
    if (threshold < 1.5)  return { label: "VERY HIGH", color: "var(--accent)" };
    if (threshold < 2.5)  return { label: "HIGH",      color: "#ff5555" };
    if (threshold < 3.5)  return { label: "MEDIUM",    color: "var(--color-warning)" };
    if (threshold < 4.5)  return { label: "LOW",       color: "var(--color-profit)" };
    return                       { label: "VERY LOW",  color: "var(--text-muted)" };
  }
}

function SensitivitySlider({ initialThreshold, modelType = "halftrees", onApplied }) {
  const isHST = modelType === "halftrees";
  const min  = isHST ? 0.3 : 0.5;
  const max  = isHST ? 0.99 : 5.0;
  const step = isHST ? 0.01 : 0.1;

  const [value, setValue]   = useState(initialThreshold ?? (isHST ? 0.75 : 3.0));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const debounceRef         = useRef(null);

  useEffect(() => {
    if (initialThreshold != null) setValue(initialThreshold);
  }, [initialThreshold, modelType]);

  async function applyThreshold(newValue) {
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

  function handleSliderChange(e) {
    const newValue = parseFloat(e.target.value);
    setValue(newValue);
    applyThreshold(newValue);
  }

  function handlePreset(presetValue) {
    setValue(presetValue);
    applyThreshold(presetValue);
  }

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const { label, color } = getSensitivityLabel(value, modelType);
  const pct = ((value - min) / (max - min)) * 100;
  const presets = PRESETS[modelType] || PRESETS.halftrees;

  const modelTooltip = isHST
    ? "HalfSpaceTrees quantile threshold. Values closer to 1.0 = only extreme anomalies flagged."
    : "Z-Score sigma cutoff. Higher σ = only larger deviations flagged. 3σ = ~0.3% of data.";

  return (
    <PanelFrame title="SENSITIVITY CONTROL" accentTitle="// PARAMETER">
      <div className="sensitivity-slider" style={{ padding: "var(--sp-2) var(--sp-3)" }}>

        {/* Header row: label + save status */}
        <div className="sensitivity-slider__header">
          <Tooltip text={`Detection sensitivity level. Currently: ${label}. Adjust to trade off precision vs recall.`} position="top">
            <span className="sensitivity-slider__label font-bold text-xs" style={{ color }}>
              {label} SENSITIVITY
            </span>
          </Tooltip>
          <span className="sensitivity-slider__status text-xs text-muted">
            {saving ? "SAVING..." : saved ? "✓ APPLIED" : ""}
          </span>
        </div>

        {/* Value display with model type tooltip */}
        <div className="sensitivity-slider__value-row">
          <Tooltip text={modelTooltip} position="bottom" maxWidth="260px">
            <span className="text-xs text-muted" style={{ cursor: "help", borderBottom: "1px dashed var(--text-muted)" }}>
              {isHST ? "QUANTILE THRESHOLD" : "SIGMA CUTOFF"} ⓘ
            </span>
          </Tooltip>
          <span className="font-mono font-bold text-accent">{value.toFixed(2)}</span>
        </div>

        {/* Preset buttons */}
        <div className="sensitivity-slider__presets">
          {presets.map((preset) => {
            const isActive = Math.abs(value - preset.value) < (isHST ? 0.005 : 0.05);
            return (
              <Tooltip key={preset.label} text={preset.tooltip} position="top">
                <button
                  className={`preset-btn ${isActive ? "preset-btn--active" : ""}`}
                  style={isActive ? { borderColor: preset.color, color: preset.color } : {}}
                  onClick={() => handlePreset(preset.value)}
                  title={preset.fullLabel}
                >
                  {preset.label}
                </button>
              </Tooltip>
            );
          })}
        </div>

        {/* Slider track */}
        <div className="sensitivity-slider__track-wrapper">
          <input
            type="range"
            id="sensitivity-range"
            className="sensitivity-slider__input"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={handleSliderChange}
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

        {/* Range labels */}
        <div className="sensitivity-slider__range-labels">
          <Tooltip text="More sensitive: flags more events, higher false-positive rate" position="bottom">
            <span className="text-xs text-muted" style={{ cursor: "help" }}>
              {isHST ? "0.30 ◀ SENSITIVE" : "0.50σ ◀ SENSITIVE"}
            </span>
          </Tooltip>
          <Tooltip text="More conservative: only flags strong anomalies" position="bottom">
            <span className="text-xs text-muted" style={{ cursor: "help" }}>
              {isHST ? "STRICT ▶ 0.99" : "STRICT ▶ 5.00σ"}
            </span>
          </Tooltip>
        </div>

      </div>
    </PanelFrame>
  );
}

export default SensitivitySlider;
