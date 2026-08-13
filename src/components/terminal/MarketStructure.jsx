/**
 * components/terminal/MarketStructure.jsx
 * ─────────────────────────────────────────
 * Left sidebar: market metrics for the active coin.
 * Adds: tooltips on each metric, reset anomaly count button, 24h price change %,
 *       24h high/low prices, and best bid/ask spread.
 */

import React, { useCallback } from "react";
import PanelFrame from "../layout/PanelFrame";
import Tooltip from "../ui/Tooltip";
import useTickStore from "../../store/tickStore";
import { formatPrice } from "../../utils/formatters";

const METRIC_TOOLTIPS = {
  SCORE: "Latest anomaly score from the active ML model. Values near 1.0 (HST) or high σ (Z-Score) indicate unusual market behaviour.",
  STATUS: "Current anomaly state for the most recent tick. ANOMALY DETECTED means the score exceeded the configured threshold.",
  ANOMALIES: "Total anomalies detected for this coin since session started. Click ↺ to reset.",
  VOLUME: "24-hour trading volume in USD (quote volume) from the last tick.",
  MODEL: "Active detection model regime. QUANTILE-HST = HalfSpaceTrees. Z-SCORE-EWMA = Rolling Z-Score with exponential weighting.",
  TICKS: "Total ticks processed this session across all coins.",
  UPTIME: "Time since the scoring worker was started on the backend.",
  PRICE_CHANGE: "24-hour price change percentage from the last received tick.",
  HIGH_24H: "24-hour high price from the Binance ticker (highPrice field).",
  LOW_24H: "24-hour low price from the Binance ticker (lowPrice field).",
  SPREAD: "Bid/ask spread: (ask − bid) / mid × 100. Widens during illiquidity or high volatility.",
};

export default function MarketStructure({ activeCoin, stats }) {
  const EMPTY_ARRAY = [];

  const history = useTickStore(
    (state) => state.tickHistory[activeCoin] ?? EMPTY_ARRAY
  );
  const latest = useTickStore(
    (state) => state.latestByCoins[activeCoin]
  );
  const anomalyCount = useTickStore(
    (state) => state.anomalyCounts[activeCoin] || 0
  );
  const resetAnomalyCount = useTickStore((state) => state.resetAnomalyCount);

  const handleResetAnomalies = useCallback(() => {
    resetAnomalyCount(activeCoin);
  }, [activeCoin, resetAnomalyCount]);

  const score     = latest ? (latest.anomaly_score || 0).toFixed(4) : "0.0000";
  const vol24h    = latest?.volume_24h
    ? `$${(latest.volume_24h / 1e6).toFixed(2)}M`
    : "---";
  const isAnomaly = latest?.is_anomaly || false;
  const price     = latest?.price_usd ? formatPrice(latest.price_usd) : "---";

  const change24h  = latest?.price_change_24h;
  const changeStr  = change24h != null
    ? `${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%`
    : "---";
  const changeClass = change24h == null ? "" : change24h >= 0 ? "text-profit" : "text-loss";

  // 24h high / low
  const high24h = latest?.high_price ? formatPrice(latest.high_price) : "---";
  const low24h  = latest?.low_price  ? formatPrice(latest.low_price)  : "---";

  // Bid/ask spread in basis points
  const bid = latest?.bid_price || 0;
  const ask = latest?.ask_price || 0;
  const mid = (bid + ask) / 2;
  const spreadPct = mid > 0 ? (((ask - bid) / mid) * 100).toFixed(4) : null;
  const spreadStr = spreadPct != null
    ? `${spreadPct}% (${formatPrice(ask - bid)})`
    : "---";

  return (
    <PanelFrame title="MKT STRUCTURE" accentTitle="// METRICS">
      <div className="market-structure">

        {/* Price Hero */}
        <div className="market-price-hero">
          <span className="market-stat-label">
            {(latest?.symbol || activeCoin).toUpperCase()}/USDT
          </span>
          <span className="market-price-value font-bold text-accent">{price}</span>
          <Tooltip text={METRIC_TOOLTIPS.PRICE_CHANGE} position="right">
            <span className={`market-change-badge ${changeClass}`} style={{ cursor: "help" }}>
              {changeStr}
            </span>
          </Tooltip>
        </div>

        <div className="divider" />

        {/* Anomaly detection metrics */}
        <div className="market-stat-group">
          <Tooltip text={METRIC_TOOLTIPS.SCORE} position="right" maxWidth="240px">
            <div className="market-stat-row" style={{ cursor: "help" }}>
              <span className="market-stat-label">LAST SCORE ⓘ</span>
              <span className={`market-stat-value ${isAnomaly ? "text-loss font-bold" : "text-profit"}`}>
                {score}
              </span>
            </div>
          </Tooltip>

          <Tooltip text={METRIC_TOOLTIPS.STATUS} position="right" maxWidth="240px">
            <div className="market-stat-row" style={{ cursor: "help" }}>
              <span className="market-stat-label">STATUS ⓘ</span>
              <span className={`red-badge ${isAnomaly ? "red-badge--loss" : "red-badge--profit"}`}>
                {isAnomaly ? "⚡ ANOMALY" : "● NORMAL"}
              </span>
            </div>
          </Tooltip>

          <div className="market-stat-row">
            <Tooltip text={METRIC_TOOLTIPS.ANOMALIES} position="right" maxWidth="240px">
              <span className="market-stat-label" style={{ cursor: "help" }}>
                ANOMALIES (SESSION) ⓘ
              </span>
            </Tooltip>
            <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
              <span className="market-stat-value text-loss font-bold">{anomalyCount}</span>
              {anomalyCount > 0 && (
                <Tooltip text="Reset anomaly count for this coin" position="top">
                  <button
                    className="icon-btn"
                    onClick={handleResetAnomalies}
                    aria-label="Reset anomaly count"
                  >
                    ↺
                  </button>
                </Tooltip>
              )}
            </span>
          </div>
        </div>

        <div className="divider" />

        {/* 24h price range */}
        <div className="market-stat-group">
          <Tooltip text={METRIC_TOOLTIPS.HIGH_24H} position="right">
            <div className="market-stat-row" style={{ cursor: "help" }}>
              <span className="market-stat-label">24H HIGH ⓘ</span>
              <span className="market-stat-value text-profit">{high24h}</span>
            </div>
          </Tooltip>

          <Tooltip text={METRIC_TOOLTIPS.LOW_24H} position="right">
            <div className="market-stat-row" style={{ cursor: "help" }}>
              <span className="market-stat-label">24H LOW ⓘ</span>
              <span className="market-stat-value text-loss">{low24h}</span>
            </div>
          </Tooltip>

          <Tooltip text={METRIC_TOOLTIPS.SPREAD} position="right" maxWidth="260px">
            <div className="market-stat-row" style={{ cursor: "help" }}>
              <span className="market-stat-label">BID/ASK SPREAD ⓘ</span>
              <span className="market-stat-value" style={{ fontSize: "0.65rem" }}>
                {spreadStr}
              </span>
            </div>
          </Tooltip>
        </div>

        <div className="divider" />

        {/* Market data */}
        <div className="market-stat-group">
          <Tooltip text={METRIC_TOOLTIPS.VOLUME} position="right">
            <div className="market-stat-row" style={{ cursor: "help" }}>
              <span className="market-stat-label">24H VOLUME ⓘ</span>
              <span className="market-stat-value">{vol24h}</span>
            </div>
          </Tooltip>

          <Tooltip text={METRIC_TOOLTIPS.MODEL} position="right" maxWidth="260px">
            <div className="market-stat-row" style={{ cursor: "help" }}>
              <span className="market-stat-label">MODEL REGIME ⓘ</span>
              <span className="market-stat-value text-secondary" style={{ fontSize: "0.65rem" }}>
                {stats?.current_model === "halftrees" ? "QUANTILE-HST" : "Z-SCORE-EWMA"}
              </span>
            </div>
          </Tooltip>
        </div>

        <div className="divider" />

        {/* Session stats */}
        <div className="market-stat-group">
          <Tooltip text={METRIC_TOOLTIPS.TICKS} position="right">
            <div className="market-stat-row" style={{ cursor: "help" }}>
              <span className="market-stat-label">TOTAL TICKS ⓘ</span>
              <span className="market-stat-value">
                {stats?.ticks_total ?? history.length}
              </span>
            </div>
          </Tooltip>

          <Tooltip text={METRIC_TOOLTIPS.UPTIME} position="right">
            <div className="market-stat-row" style={{ cursor: "help" }}>
              <span className="market-stat-label">UPTIME ⓘ</span>
              <span className="market-stat-value">
                {stats?.uptime_seconds
                  ? `${Math.floor(stats.uptime_seconds / 60)}m ${stats.uptime_seconds % 60}s`
                  : "---"}
              </span>
            </div>
          </Tooltip>
        </div>

      </div>
    </PanelFrame>
  );
}
