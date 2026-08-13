/**
 * components/dashboard/LiveChart.jsx
 * ────────────────────────────────────
 * Real-time price chart using TradingView's lightweight-charts v5.
 *
 * Layout
 * ──────
 * The chart uses two panes stacked vertically:
 *   Pane 0 (top, ~75% height) — price LineSeries + anomaly markers
 *   Pane 1 (bottom, ~25% height) — volume HistogramSeries
 *
 * The volume histogram gives at-a-glance confirmation of anomaly validity:
 * a high-score anomaly on low volume is often a data artefact; one on a
 * volume spike is more likely a real market event.
 *
 * Time range buttons
 * ──────────────────
 * Three buttons (1H / 6H / ALL) call chart.timeScale().setVisibleRange()
 * to zoom to the selected window. "ALL" calls fitContent() instead, which
 * auto-fits whatever history is loaded regardless of session length.
 *
 * Price formatter
 * ───────────────
 * The right price scale uses formatPrice() from utils/formatters.js so
 * labels are compact ($60.1K) rather than raw numbers (60100.00).
 *
 * Anomaly markers
 * ───────────────
 * Markers now show both the anomaly score and the price at that moment:
 * "⚠ 0.9932 @ $60,123" — so the user can cross-reference the chart visually.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  createChart,
  LineStyle,
  LineSeries,
  HistogramSeries,
  createSeriesMarkers,
} from "lightweight-charts";
import useTickStore from "../../store/tickStore";
import { isoToUnixSec, formatPrice } from "../../utils/formatters";
import Spinner from "../ui/Spinner";

// ── Time range button definitions ─────────────────────────────────────────────
/** Each entry maps a label to the number of seconds to look back from now.
 *  null means "show all available data" (uses fitContent). */
const TIME_RANGE_OPTIONS = [
  { label: "1H",  seconds: 3600 },
  { label: "6H",  seconds: 6 * 3600 },
  { label: "ALL", seconds: null },
];

function LiveChart({ coinId, className = "" }) {
  const containerRef   = useRef(null);
  const chartRef       = useRef(null);
  const priceSeriesRef = useRef(null);
  const volSeriesRef   = useRef(null);
  const markersApiRef  = useRef(null);
  const markerDataRef  = useRef([]);
  const unsubscribeRef = useRef(null);

  const [hasData, setHasData]           = useState(false);
  const [activeRange, setActiveRange]   = useState("ALL");

  // ── Chart initialisation (runs once on mount) ────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    // Create the chart with dark crimson terminal theme.
    // autoSize:true lets lightweight-charts manage its own ResizeObserver —
    // no need to wire one up manually.
    chartRef.current = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background:  { color: "#050505" },
        textColor:   "#a0a0a0",
        fontFamily:  "'JetBrains Mono', monospace",
        fontSize:    12,
      },
      grid: {
        vertLines: { color: "rgba(255, 26, 26, 0.04)", style: LineStyle.Dotted },
        horzLines: { color: "rgba(255, 26, 26, 0.04)", style: LineStyle.Dotted },
      },
      crosshair: {
        mode: 1,
        vertLine: { color: "rgba(255, 26, 26, 0.5)", width: 1 },
        horzLine: { color: "rgba(255, 26, 26, 0.5)", width: 1 },
      },
      // Pane 0 (price) — right price scale with compact formatter
      rightPriceScale: {
        borderColor: "#1a1a1a",
        textColor:   "#a0a0a0",
      },
      timeScale: {
        borderColor:    "#1a1a1a",
        textColor:      "#a0a0a0",
        timeVisible:    true,
        secondsVisible: true,
      },
      handleScroll: true,
      handleScale:  true,
    });

    // ── Price LineSeries (Pane 0) ──────────────────────────────────────────
    priceSeriesRef.current = chartRef.current.addSeries(LineSeries, {
      color:                         "#ff1a1a",
      lineWidth:                     2,
      crosshairMarkerVisible:        true,
      crosshairMarkerRadius:         5,
      crosshairMarkerBorderColor:    "#ff3333",
      crosshairMarkerBackgroundColor:"#050505",
      priceLineVisible:              true,
      priceLineColor:                "rgba(255, 26, 26, 0.4)",
      priceLineWidth:                1,
      priceLineStyle:                LineStyle.Dashed,
      lastValueVisible:              true,
      // Compact price labels: "$60.1K" instead of "60100.00"
      priceFormat: {
        type:      "custom",
        formatter: (price) => formatPrice(price),
      },
    });

    // ── Volume HistogramSeries (Pane 1) ────────────────────────────────────
    // A separate pane keeps the volume scale from distorting the price scale.
    // The histogram uses a muted crimson so it is visually subordinate to
    // the price line but still clearly readable.
    volSeriesRef.current = chartRef.current.addSeries(HistogramSeries, {
      color:           "rgba(255, 26, 26, 0.35)",
      priceFormat:     { type: "volume" },
      // Assign to pane index 1 (created automatically when index > 0)
      pane:            1,
      priceScaleId:    "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });

    // Constrain the volume pane to ~25% of total chart height
    chartRef.current.panes()[1]?.setHeight(
      Math.round((containerRef.current.clientHeight || 400) * 0.25)
    );

    // Attach the markers plugin to the price series
    markersApiRef.current = createSeriesMarkers(priceSeriesRef.current, []);

    return () => {
      chartRef.current?.remove();
      chartRef.current    = null;
      priceSeriesRef.current = null;
      volSeriesRef.current   = null;
      markersApiRef.current  = null;
    };
  }, []);

  // ── Time range button handler ─────────────────────────────────────────────
  /**
   * Zoom the chart to the selected time range.
   * Uses setVisibleRange() for specific windows and fitContent() for ALL,
   * so the chart always fills the pane regardless of session length.
   */
  const handleRangeSelect = useCallback((option) => {
    if (!chartRef.current) return;
    setActiveRange(option.label);

    const ts = chartRef.current.timeScale();
    if (option.seconds === null) {
      ts.fitContent();
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    ts.setVisibleRange({ from: now - option.seconds, to: now });
  }, []);

  // ── Coin switching: reload history ───────────────────────────────────────
  useEffect(() => {
    if (!priceSeriesRef.current || !volSeriesRef.current) return;

    // Clear both series and reset marker state on every coin switch
    priceSeriesRef.current.setData([]);
    volSeriesRef.current.setData([]);
    if (markersApiRef.current) markersApiRef.current.setMarkers([]);
    markerDataRef.current = [];
    setHasData(false);

    // Unsubscribe previous live tick listener
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }

    // Seed the chart with available history for this coin
    const history = useTickStore.getState().tickHistory[coinId] || [];
    if (history.length > 0) {
      _applyHistory(history);
      setHasData(true);
    }

    // Subscribe to new live ticks for this coin
    unsubscribeRef.current = useTickStore.subscribe(
      (state) => state.latestByCoins[coinId],
      (latestTick) => {
        if (!latestTick || !priceSeriesRef.current) return;
        _applyLiveTick(latestTick);
        setHasData(true);
      }
    );

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [coinId]);

  /**
   * Seed both series from a full history array.
   * Deduplicates by timestamp (Map) to guard against repeated polled_at values.
   *
   * @param {ScoredTick[]} history - Array of ticks, oldest-first.
   */
  function _applyHistory(history) {
    // Deduplicate price and volume points by unix-second timestamp
    const priceMap  = new Map();
    const volMap    = new Map();
    const markerMap = new Map();

    history.forEach((t) => {
      const timeSec = isoToUnixSec(t.polled_at);
      priceMap.set(timeSec, t.price_usd);
      volMap.set(timeSec, t.volume_24h);

      if (t.is_anomaly) {
        markerMap.set(timeSec, _buildMarker(timeSec, t.anomaly_score, t.price_usd));
      }
    });

    const pricePoints = _sortedEntries(priceMap).map(([time, value]) => ({ time, value }));
    const volPoints   = _sortedEntries(volMap).map(([time, value])   => ({ time, value }));
    const markers     = _sortedEntries(markerMap).map(([, m]) => m);

    priceSeriesRef.current?.setData(pricePoints);
    volSeriesRef.current?.setData(volPoints);
    markerDataRef.current = markers;
    if (markersApiRef.current) markersApiRef.current.setMarkers(markers);
  }

  /**
   * Incrementally update both series with a single new live tick.
   * Adds/updates the marker map if the tick is flagged as an anomaly.
   *
   * @param {ScoredTick} tick - The latest scored tick from the WebSocket.
   */
  function _applyLiveTick(tick) {
    const timeSec = isoToUnixSec(tick.polled_at);

    priceSeriesRef.current?.update({ time: timeSec, value: tick.price_usd });
    volSeriesRef.current?.update({ time: timeSec, value: tick.volume_24h });

    if (tick.is_anomaly) {
      const marker = _buildMarker(timeSec, tick.anomaly_score, tick.price_usd);
      // Replace existing marker at this timestamp (dedup) then re-sort
      const markerMap = new Map(markerDataRef.current.map((m) => [m.time, m]));
      markerMap.set(timeSec, marker);
      const sorted = Array.from(markerMap.values()).sort((a, b) => a.time - b.time);
      markerDataRef.current = sorted;
      if (markersApiRef.current) markersApiRef.current.setMarkers(sorted);
    }
  }

  /**
   * Build a lightweight-charts series marker for an anomaly tick.
   * Text includes both the anomaly score and the price so the user can
   * correlate the marker with the price level without moving the crosshair.
   *
   * @param {number} timeSec     - Unix timestamp in seconds.
   * @param {number} score       - Anomaly score (0–1 for HST, z-score for ZScore).
   * @param {number} priceUsd    - Price in USD at the time of the anomaly.
   * @returns {object}           - lightweight-charts marker descriptor.
   */
  function _buildMarker(timeSec, score, priceUsd) {
    return {
      time:     timeSec,
      position: "aboveBar",
      color:    "#ff1a1a",
      shape:    "arrowDown",
      text:     `⚠ ${score.toFixed(4)} @ ${formatPrice(priceUsd)}`,
      size:     1,
    };
  }

  /** Sort a Map<number, V> by key and return entries array. */
  function _sortedEntries(map) {
    return Array.from(map.entries()).sort(([a], [b]) => a - b);
  }

  return (
    <div className={`live-chart ${className}`} id={`chart-panel-${coinId}`}>
      {/* Time range selector — absolute-positioned over the chart top-right */}
      <div className="live-chart__range-btns" aria-label="Chart time range">
        {TIME_RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.label}
            className={`range-btn ${activeRange === opt.label ? "range-btn--active" : ""}`}
            onClick={() => handleRangeSelect(opt)}
            aria-pressed={activeRange === opt.label}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {!hasData && (
        <div className="live-chart__loading">
          <Spinner size="30px" label="Waiting for live telemetry stream..." />
          <p
            className="text-xs text-muted"
            style={{ marginTop: "8px", fontFamily: "var(--font-mono)" }}
          >
            AWAITING FIRST TICK STREAM...
          </p>
        </div>
      )}

      <div ref={containerRef} className="live-chart__canvas" />
    </div>
  );
}

export default LiveChart;
