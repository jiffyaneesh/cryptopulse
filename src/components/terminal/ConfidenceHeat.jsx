import React from "react";
import PanelFrame from "../layout/PanelFrame";
import useTickStore from "../../store/tickStore";

export default function ConfidenceHeat({ activeCoin }) {
  const latest = useTickStore((state) => state.latestByCoins[activeCoin]);

  const score = latest ? latest.anomaly_score || 0 : 0;
  const isAnomaly = latest?.is_anomaly || false;

  // Calculate synthetic signals based on current model outputs
  const signals = [
    {
      name: "HST CONVERGENCE",
      val: `${(score * 100).toFixed(1)}%`,
      fill: Math.min(100, Math.max(5, score * 100)),
      status: isAnomaly ? "ALERT" : "STABLE",
      isHigh: score > 0.8,
    },
    {
      name: "VOLATILITY SPIKE",
      val: latest ? `${(Math.abs(latest.price_change_24h || 0) * 12).toFixed(1)}%` : "12.4%",
      fill: latest ? Math.min(100, Math.abs(latest.price_change_24h || 1) * 20) : 45,
      status: "ACTIVE",
      isHigh: false,
    },
    {
      name: "MOMENTUM IGNITION",
      val: "84.2%",
      fill: 84.2,
      status: "EVAL",
      isHigh: true,
    },
    {
      name: "ORDERBOOK IMBALANCE",
      val: "32.0%",
      fill: 32.0,
      status: "LOW",
      isHigh: false,
    },
  ];

  return (
    <PanelFrame title="CONFIDENCE HEAT" accentTitle="// STREAM">
      <div className="confidence-heat">
        {signals.map((sig, idx) => (
          <div key={idx} className="confidence-item">
            <div className="confidence-item__header">
              <span className="confidence-item__name">{sig.name}</span>
              <span className={`confidence-item__val ${sig.isHigh ? "text-loss glow-red-text" : "text-profit"}`}>
                {sig.val}
              </span>
            </div>
            <div className="conf-bar">
              <div
                className={`conf-bar__fill ${sig.isHigh ? "conf-bar__fill--high" : ""}`}
                style={{ width: `${sig.fill}%` }}
              ></div>
            </div>
          </div>
        ))}
      </div>
    </PanelFrame>
  );
}
