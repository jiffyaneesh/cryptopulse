/**
 * components/research/InteractivePlayground.jsx
 * ─────────────────────────────────────────────
 * Interactive Mathematical Playground for exploring streaming formulas
 * in real-time (HalfSpaceTrees decay, Volatility Normalization, Quantile cutoffs).
 */

import React, { useState, useMemo } from "react";
import MathFormula, { InlineMath } from "./MathFormula";

export function InteractivePlayground() {
  const [returnPct, setReturnPct] = useState(2.4); // 2.4% return move
  const [rollingVol, setRollingVol] = useState(0.8); // 0.8% rolling vol
  const [windowMass, setWindowMass] = useState(14); // 14 items in node
  const [treeDepth, setTreeDepth] = useState(6); // depth 6
  const [quantileQ, setQuantileQ] = useState(0.99); // 0.99
  const [volSurpriseRatio, setVolSurpriseRatio] = useState(3.5); // 3.5x normal volume

  // Calculated formulas
  const zScore = useMemo(() => {
    const vol = Math.max(rollingVol, 0.001);
    return (returnPct / vol).toFixed(2);
  }, [returnPct, rollingVol]);

  const volumeSurprise = useMemo(() => {
    return Math.log(Math.max(volSurpriseRatio, 0.001)).toFixed(3);
  }, [volSurpriseRatio]);

  const hstNodeScore = useMemo(() => {
    // mass * 2^depth
    const raw = windowMass * Math.pow(2, treeDepth);
    return raw.toLocaleString();
  }, [windowMass, treeDepth]);

  const theoreticalAnomalyRate = useMemo(() => {
    return ((1 - quantileQ) * 100).toFixed(2);
  }, [quantileQ]);

  const isZAnomaly = Math.abs(parseFloat(zScore)) >= 3.0;

  return (
    <div className="math-playground">
      <div className="math-playground__header">
        <span className="math-playground__title">
          🔬 Interactive Theory & Parameter Simulator
        </span>
        <span style={{ fontSize: "0.75rem", color: "var(--paper-text-muted)" }}>
          Simulating Real-Time Equations
        </span>
      </div>

      <div className="math-playground__grid">
        {/* Slider 1: Return % */}
        <div className="math-slider-group">
          <label>
            <span>Current Tick Move (<InlineMath math="r_t" />)</span>
            <span className="val">{returnPct >= 0 ? `+${returnPct}%` : `${returnPct}%`}</span>
          </label>
          <input
            type="range"
            min="-10"
            max="10"
            step="0.1"
            value={returnPct}
            onChange={(e) => setReturnPct(parseFloat(e.target.value))}
          />
        </div>

        {/* Slider 2: Rolling Volatility */}
        <div className="math-slider-group">
          <label>
            <span>Realized Volatility (<InlineMath math="\hat{\sigma}_t" />)</span>
            <span className="val">{rollingVol}%</span>
          </label>
          <input
            type="range"
            min="0.1"
            max="5.0"
            step="0.1"
            value={rollingVol}
            onChange={(e) => setRollingVol(parseFloat(e.target.value))}
          />
        </div>

        {/* Slider 3: Volume Shock */}
        <div className="math-slider-group">
          <label>
            <span>Volume Multiple (<InlineMath math="V_t / \bar{V}_W" />)</span>
            <span className="val">{volSurpriseRatio}x</span>
          </label>
          <input
            type="range"
            min="0.1"
            max="15.0"
            step="0.1"
            value={volSurpriseRatio}
            onChange={(e) => setVolSurpriseRatio(parseFloat(e.target.value))}
          />
        </div>

        {/* Slider 4: HST Node Mass */}
        <div className="math-slider-group">
          <label>
            <span>HST Partition Mass (<InlineMath math="r_u" />)</span>
            <span className="val">{windowMass} ticks</span>
          </label>
          <input
            type="range"
            min="0"
            max="150"
            step="1"
            value={windowMass}
            onChange={(e) => setWindowMass(parseInt(e.target.value))}
          />
        </div>

        {/* Slider 5: HST Depth */}
        <div className="math-slider-group">
          <label>
            <span>Tree Depth (<InlineMath math="k = \text{depth}(u)" />)</span>
            <span className="val">level {treeDepth}</span>
          </label>
          <input
            type="range"
            min="1"
            max="10"
            step="1"
            value={treeDepth}
            onChange={(e) => setTreeDepth(parseInt(e.target.value))}
          />
        </div>

        {/* Slider 6: Quantile Filter */}
        <div className="math-slider-group">
          <label>
            <span>Quantile Cutoff (<InlineMath math="q" />)</span>
            <span className="val">{quantileQ}</span>
          </label>
          <input
            type="range"
            min="0.90"
            max="0.999"
            step="0.001"
            value={quantileQ}
            onChange={(e) => setQuantileQ(parseFloat(e.target.value))}
          />
        </div>
      </div>

      {/* Real-time calculated results */}
      <div className="math-result-box">
        <div className="math-result-item">
          <span className="label">
            Vol-Standardized Return <InlineMath math="z_{\text{ret}} = r_t / \hat{\sigma}_t" />:
          </span>
          <span className="value" style={{ color: isZAnomaly ? "#ff3333" : "#00ff88" }}>
            {zScore}σ {isZAnomaly ? "🚨 (ANOMALY: |z| ≥ 3.0)" : "✓ (Normal)"}
          </span>
        </div>

        <div className="math-result-item">
          <span className="label">
            Volume Surprise <InlineMath math="\delta_{v, t} = \ln(V_t / \bar{V}_W)" />:
          </span>
          <span className="value">{volumeSurprise} log-units</span>
        </div>

        <div className="math-result-item">
          <span className="label">
            HST Path Mass Weight <InlineMath math="\text{mass}(u) \times 2^{\text{depth}(u)}" />:
          </span>
          <span className="value">{hstNodeScore} units</span>
        </div>

        <div className="math-result-item">
          <span className="label">
            Theoretical Flagging Density <InlineMath math="1 - q" />:
          </span>
          <span className="value">{theoreticalAnomalyRate}% of tick stream</span>
        </div>
      </div>
    </div>
  );
}

export default InteractivePlayground;
