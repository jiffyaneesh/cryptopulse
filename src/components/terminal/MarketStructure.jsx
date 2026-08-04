import React from "react";
import PanelFrame from "../layout/PanelFrame";
import useTickStore from "../../store/tickStore";

export default function MarketStructure({ activeCoin, stats }) {
  const history = useTickStore((state) => state.tickHistory[activeCoin] || []);
  const latest = history[history.length - 1];
  const anomalyCount = useTickStore((state) => state.anomalyCounts[activeCoin] || 0);

  const score = latest ? (latest.anomaly_score || 0).toFixed(4) : "0.0000";
  const vol24h = latest?.volume_24h ? `$${(latest.volume_24h / 1e6).toFixed(2)}M` : "---";
  const isAnomaly = latest?.is_anomaly || false;

  return (
    <PanelFrame title="MKT STRUCTURE" accentTitle="// METRICS">
      <div className="market-structure">
        <div className="market-stat-group">
          <div className="market-stat-row">
            <span className="market-stat-label">ACTIVE PAIR</span>
            <span className="market-stat-value text-accent font-bold">
              {activeCoin.toUpperCase()}
            </span>
          </div>
          <div className="market-stat-row">
            <span className="market-stat-label">LAST SCORE</span>
            <span className={`market-stat-value ${isAnomaly ? "text-loss font-bold" : "text-profit"}`}>
              {score}
            </span>
          </div>
          <div className="market-stat-row">
            <span className="market-stat-label">STATUS</span>
            <span className={`red-badge ${isAnomaly ? "red-badge--loss" : "red-badge--profit"}`}>
              {isAnomaly ? "ANOMALY DETECTED" : "NORMAL STREAM"}
            </span>
          </div>
        </div>

        <div className="divider"></div>

        <div className="market-stat-group">
          <div className="market-stat-row">
            <span className="market-stat-label">ANOMALIES (SESSION)</span>
            <span className="market-stat-value text-loss font-bold">{anomalyCount}</span>
          </div>
          <div className="market-stat-row">
            <span className="market-stat-label">24H VOLUME</span>
            <span className="market-stat-value">{vol24h}</span>
          </div>
          <div className="market-stat-row">
            <span className="market-stat-label">MODEL REGIME</span>
            <span className="market-stat-value text-secondary">
              {stats?.current_model === "halftrees" ? "QUANTILE-HST" : "Z-SCORE-EWMA"}
            </span>
          </div>
        </div>

        <div className="divider"></div>

        <div className="market-stat-group">
          <div className="market-stat-row">
            <span className="market-stat-label">TOTAL TICKS</span>
            <span className="market-stat-value">{stats?.ticks_total || history.length}</span>
          </div>
          <div className="market-stat-row">
            <span className="market-stat-label">UPTIME</span>
            <span className="market-stat-value">{stats?.uptime_seconds ? `${Math.floor(stats.uptime_seconds / 60)}m` : "---"}</span>
          </div>
        </div>
      </div>
    </PanelFrame>
  );
}
