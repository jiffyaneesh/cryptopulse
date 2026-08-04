/**
 * components/terminal/ConfidenceHeat.jsx
 * ────────────────────────────────────────
 * Signal confidence bars with explanatory tooltips.
 *
 * Signals:
 *   HST CONVERGENCE     — live from model output (anomaly_score)
 *   VOLATILITY SPIKE    — derived from price_change_24h
 *   MOMENTUM IGNITION   — synthetic placeholder
 *   ORDERBOOK IMBALANCE — synthetic placeholder
 */

import React from "react";
import PanelFrame from "../layout/PanelFrame";
import Tooltip from "../ui/Tooltip";
import useTickStore from "../../store/tickStore";

const SIGNAL_TOOLTIPS = {
  "HST CONVERGENCE": "HalfSpaceTrees model confidence. High % = score far above threshold. Updates on every live tick.",
  "VOLATILITY SPIKE": "Derived from 24h price change. High % = large absolute price move vs baseline.",
  "MOMENTUM IGNITION": "Placeholder. Would measure sudden directional acceleration in price. Integrate order-flow data to activate.",
  "ORDERBOOK IMBALANCE": "Placeholder. Measures bid/ask depth imbalance. Requires Level 2 orderbook feed to activate.",
};

const STATUS_COLORS = {
  ALERT:  "var(--accent)",
  ACTIVE: "var(--color-warning)",
  EVAL:   "var(--text-secondary)",
  LOW:    "var(--text-muted)",
  STABLE: "var(--color-profit)",
};

export default function ConfidenceHeat({ activeCoin }) {
  const latest = useTickStore((state) => state.latestByCoins[activeCoin]);

  const score     = latest ? latest.anomaly_score || 0 : 0;
  const isAnomaly = latest?.is_anomaly || false;

  const signals = [
    {
      name: "HST CONVERGENCE",
      val: `${(score * 100).toFixed(1)}%`,
      fill: Math.min(100, Math.max(5, score * 100)),
      status: isAnomaly ? "ALERT" : "STABLE",
      isHigh: score > 0.8,
      live: true,
    },
    {
      name: "VOLATILITY SPIKE",
      val: latest
        ? `${(Math.abs(latest.price_change_24h || 0) * 12).toFixed(1)}%`
        : "---",
      fill: latest ? Math.min(100, Math.abs(latest.price_change_24h || 1) * 20) : 0,
      status: "ACTIVE",
      isHigh: latest ? Math.abs(latest.price_change_24h || 0) > 5 : false,
      live: !!latest,
    },
    {
      name: "MOMENTUM IGNITION",
      val: "—",
      fill: 0,
      status: "EVAL",
      isHigh: false,
      live: false,
    },
    {
      name: "ORDERBOOK IMBALANCE",
      val: "—",
      fill: 0,
      status: "LOW",
      isHigh: false,
      live: false,
    },
  ];

  return (
    <PanelFrame title="CONFIDENCE HEAT" accentTitle="// STREAM">
      <div className="confidence-heat">
        {signals.map((sig) => {
          const statusColor = STATUS_COLORS[sig.status] || "var(--text-muted)";

          return (
            <div key={sig.name} className="confidence-item">
              <div className="confidence-item__header">
                <Tooltip text={SIGNAL_TOOLTIPS[sig.name]} position="left" maxWidth="240px">
                  <span
                    className="confidence-item__name"
                    style={{ cursor: "help", borderBottom: "1px dashed #333" }}
                  >
                    {sig.name} ⓘ
                  </span>
                </Tooltip>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
                  <span
                    className="confidence-item__status"
                    style={{ color: statusColor, fontSize: "0.6rem", fontWeight: 600 }}
                  >
                    {sig.status}
                  </span>
                  <span className={`confidence-item__val ${sig.isHigh ? "text-loss glow-red-text" : sig.live ? "text-profit" : "text-muted"}`}>
                    {sig.val}
                  </span>
                </div>
              </div>
              <div className="conf-bar">
                <div
                  className={`conf-bar__fill ${sig.isHigh ? "conf-bar__fill--high" : ""} ${!sig.live ? "conf-bar__fill--inactive" : ""}`}
                  style={{ width: `${sig.fill}%` }}
                />
              </div>
              {!sig.live && (
                <span style={{ fontSize: "0.6rem", color: "var(--text-muted)", marginTop: "2px" }}>
                  requires additional data feed
                </span>
              )}
            </div>
          );
        })}
      </div>
    </PanelFrame>
  );
}
