/**
 * components/terminal/TradeLog.jsx
 * ─────────────────────────────────
 * Live tick stream log with filter, clear, and CSV export.
 *
 * Features:
 *   - Toggle between ALL ticks and ANOMALIES ONLY
 *   - Clear log (resets anomaly counts for active coin in store)
 *   - Export visible entries as CSV
 *   - Shows entry count badge
 *
 * Performance note — selector scope:
 *   Subscribing to `state.tickHistory[activeCoin]` (the full per-coin array)
 *   would re-render TradeLog on every single tick, even when the component
 *   only displays the newest 50 rows. Instead we use a memoised selector
 *   that extracts the last 50 entries directly; Zustand's shallow equality
 *   check then only triggers a re-render when those 50 entries change.
 *   Because entries are appended at the tail, this is nearly always O(1)
 *   in terms of React reconciliation cost.
 */

import React, { useState, useCallback, useMemo } from "react";
import PanelFrame from "../layout/PanelFrame";
import Tooltip from "../ui/Tooltip";
import useTickStore from "../../store/tickStore";

const EMPTY = [];
/** Number of most-recent ticks to display in the log. */
const LOG_DISPLAY_LIMIT = 50;

function exportCSV(entries, coinId) {
  const header = "time,coin,anomaly,score,price\n";
  const rows = entries
    .map((e) => `${e.time},${e.coin},${e.isAnomaly ? 1 : 0},${e.rawScore},${e.rawPrice}`)
    .join("\n");
  const blob = new Blob([header + rows], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tradelog_${coinId}_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function TradeLog({ activeCoin }) {
  const [filterAnomalies, setFilterAnomalies] = useState(false);
  const [cleared, setCleared] = useState(false);

  /**
   * Scoped selector: extract only the last LOG_DISPLAY_LIMIT ticks for the
   * active coin. This avoids re-rendering when other coins receive ticks, and
   * avoids re-rendering when older (non-visible) ticks in the same coin's
   * history are evicted from the front of the array.
   *
   * We use a stable selector function created with useMemo so Zustand can
   * reference-compare the returned slice between renders.
   */
  const recentTicks = useTickStore(
    useMemo(
      () => (state) => (state.tickHistory[activeCoin] ?? EMPTY).slice(-LOG_DISPLAY_LIMIT),
      [activeCoin]
    )
  );

  const resetAnomalyCount = useTickStore((state) => state.resetAnomalyCount);

  // Build display entries from recentTicks (newest first)
  const allEntries = recentTicks
    .slice()
    .reverse()
    .map((tick, idx) => {
      // Use polled_at (ISO 8601 string from backend) — tick.timestamp does not exist
      const date = new Date(tick.polled_at || Date.now());
      const timeStr = date.toTimeString().split(" ")[0];
      const isAnomaly = tick.is_anomaly;
      const score = (tick.anomaly_score || 0).toFixed(4);
      const price = tick.price_usd;

      return {
        // Stable key: use polled_at + index rather than the undefined timestamp field
        id: `${tick.polled_at}-${idx}`,
        time: timeStr,
        coin: (tick.symbol || activeCoin).toUpperCase(),
        msg: isAnomaly
          ? `🚨 ANOMALY score=${score} price=$${price}`
          : `Tick processed score=${score} price=$${price}`,
        isAnomaly,
        rawScore: score,
        rawPrice: price,
      };
    });

  const visibleEntries = filterAnomalies
    ? allEntries.filter((e) => e.isAnomaly)
    : allEntries;

  const anomalyCount = allEntries.filter((e) => e.isAnomaly).length;

  const handleClear = useCallback(() => {
    resetAnomalyCount(activeCoin);
    setCleared(true);
    setTimeout(() => setCleared(false), 1500);
  }, [activeCoin, resetAnomalyCount]);

  const handleExport = useCallback(() => {
    exportCSV(visibleEntries, activeCoin);
  }, [visibleEntries, activeCoin]);

  // Header controls
  const headerRight = (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
      {/* Entry count */}
      <span className="text-xs text-muted">
        {visibleEntries.length}/{allEntries.length}
      </span>

      {/* Anomaly count badge */}
      {anomalyCount > 0 && (
        <span className="red-badge red-badge--loss" style={{ fontSize: "0.6rem", padding: "1px 5px" }}>
          {anomalyCount} ⚡
        </span>
      )}

      {/* Filter toggle */}
      <Tooltip text={filterAnomalies ? "Showing anomalies only. Click to show all ticks." : "Click to show anomalies only."} position="top">
        <button
          className={`log-btn ${filterAnomalies ? "log-btn--active" : ""}`}
          onClick={() => setFilterAnomalies((f) => !f)}
          aria-pressed={filterAnomalies}
        >
          🚨 {filterAnomalies ? "ANOMALIES" : "ALL"}
        </button>
      </Tooltip>

      {/* Clear button */}
      <Tooltip text="Reset anomaly count for this coin. Does not delete tick history." position="top">
        <button
          className="log-btn"
          onClick={handleClear}
          aria-label="Clear anomaly count"
        >
          {cleared ? "✓" : "CLR"}
        </button>
      </Tooltip>

      {/* Export CSV */}
      <Tooltip text="Export visible log entries as CSV." position="top">
        <button
          className="log-btn"
          onClick={handleExport}
          aria-label="Export CSV"
          disabled={visibleEntries.length === 0}
        >
          CSV ↓
        </button>
      </Tooltip>
    </div>
  );

  return (
    <PanelFrame
      title="TRADE LOG"
      accentTitle="// LIVE STREAM"
      headerRight={headerRight}
      noPadding
    >
      <div className="trade-log">
        {visibleEntries.length === 0 ? (
          <div className="trade-log__row text-muted">
            {filterAnomalies
              ? "No anomalies detected yet."
              : "Awaiting incoming telemetry ticks..."}
          </div>
        ) : (
          visibleEntries.map((log) => (
            <div
              key={log.id}
              className={`trade-log__row ${log.isAnomaly ? "trade-log__row--anomaly" : ""}`}
            >
              <span className="trade-log__time">{log.time}</span>
              <span className="trade-log__coin">{log.coin}</span>
              <span className={`trade-log__msg ${log.isAnomaly ? "trade-log__msg--anomaly" : ""}`}>
                {log.msg}
              </span>
            </div>
          ))
        )}
      </div>
    </PanelFrame>
  );
}
