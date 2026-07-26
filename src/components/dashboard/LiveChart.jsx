/**
 * components/dashboard/LiveChart.jsx
 * ────────────────────────────────────
 * Real-time price chart using TradingView's lightweight-charts library.
 *
 * Performance architecture — WHY imperative canvas updates:
 *   React's VDOM re-renders the entire component subtree on state changes.
 *   At 1 tick/second × 8 coins, using React state for each tick would cause
 *   continuous frame-rate-impacting re-renders. Instead:
 *
 *   1. The chart is created ONCE via useRef (never recreated on re-render).
 *   2. Zustand's subscribe() API delivers ticks DIRECTLY to the canvas update
 *      function — completely bypassing React's render cycle.
 *   3. React state is only used for the "no data" loading state.
 *
 *   This achieves true 60fps chart updates regardless of React render frequency.
 *
 * Responsibilities:
 *   - Create and configure the lightweight-charts instance.
 *   - Subscribe to Zustand tick store for the active coin.
 *   - Render anomaly markers (red triangles) on the chart.
 *   - Handle coin switching (clear and reload history).
 *   - Resize the chart responsively via ResizeObserver.
 *
 * NOT responsible for:
 *   - WebSocket connection (see hooks/useWebSocket.js).
 *   - Fetching historical data (handled by Dashboard.jsx on coin change).
 *
 * @module components/dashboard/LiveChart
 */

import React, { useEffect, useRef, useState } from "react";
import { createChart, LineStyle } from "lightweight-charts";
import useTickStore from "../../store/tickStore";
import { isoToUnixSec, formatPrice } from "../../utils/formatters";
import Spinner from "../ui/Spinner";

/**
 * LiveChart — Canvas-based real-time price chart with anomaly markers.
 *
 * @param {object} props
 * @param {string} props.coinId     - Active coin_id to display.
 * @param {string} [props.className] - Additional CSS classes for the container.
 * @returns {React.ReactElement}
 */
function LiveChart({ coinId, className = "" }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const markerDataRef = useRef([]);  // Accumulate markers; batch-set on anomaly
  const unsubscribeRef = useRef(null);
  const [hasData, setHasData] = useState(false);

  // ── Chart initialisation (runs once on mount) ──────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    // Create the chart instance with dark terminal theme
    chartRef.current = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "hsl(220, 15%, 65%)",
        fontFamily: "'Inter', sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "hsla(220, 20%, 50%, 0.08)", style: LineStyle.Dotted },
        horzLines: { color: "hsla(220, 20%, 50%, 0.08)", style: LineStyle.Dotted },
      },
      crosshair: {
        mode: 1, // Normal crosshair mode
        vertLine: { color: "hsla(195, 100%, 60%, 0.6)", width: 1 },
        horzLine: { color: "hsla(195, 100%, 60%, 0.6)", width: 1 },
      },
      rightPriceScale: {
        borderColor: "hsla(220, 20%, 50%, 0.15)",
        textColor: "hsl(220, 15%, 55%)",
      },
      timeScale: {
        borderColor: "hsla(220, 20%, 50%, 0.15)",
        textColor: "hsl(220, 15%, 55%)",
        timeVisible: true,
        secondsVisible: true,
      },
      handleScroll: true,
      handleScale: true,
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 400,
    });

    // Line series for live price data
    seriesRef.current = chartRef.current.addLineSeries({
      color: "hsl(195, 100%, 50%)",    // Electric cyan — matches accent color
      lineWidth: 2,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: "hsl(195, 100%, 70%)",
      crosshairMarkerBackgroundColor: "hsl(225, 20%, 8%)",
      priceLineVisible: true,
      priceLineColor: "hsla(195, 100%, 50%, 0.4)",
      priceLineWidth: 1,
      priceLineStyle: LineStyle.Dashed,
      lastValueVisible: true,
    });

    // ResizeObserver keeps the chart width in sync with the container.
    // Without this, the chart overflows or appears cut off on window resize.
    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (chartRef.current) {
        chartRef.current.applyOptions({ width, height: height || 400 });
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []); // Run ONCE — chart instance is never recreated

  // ── Coin switching: reload history ────────────────────────────────────
  useEffect(() => {
    if (!seriesRef.current) return;

    // Clear series data and markers when coin changes
    seriesRef.current.setData([]);
    seriesRef.current.setMarkers([]);
    markerDataRef.current = [];
    setHasData(false);

    // Unsubscribe from previous coin's store subscription
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }

    // Load existing history for the new coin from the store
    const history = useTickStore.getState().tickHistory[coinId] || [];
    if (history.length > 0) {
      const points = history.map((t) => ({
        time: isoToUnixSec(t.polled_at),
        value: t.price_usd,
      }));
      seriesRef.current.setData(points);

      // Rebuild anomaly markers from history
      const markers = history
        .filter((t) => t.is_anomaly)
        .map((t) => ({
          time: isoToUnixSec(t.polled_at),
          position: "aboveBar",
          color: "hsl(350, 100%, 60%)",  // Anomaly red
          shape: "arrowDown",
          text: `⚠ ${t.anomaly_score.toFixed(3)}`,
          size: 1,
        }));
      markerDataRef.current = markers;
      seriesRef.current.setMarkers(markers);
      setHasData(true);
    }

    // Subscribe to new ticks for this coin via Zustand subscribe() — NOT the hook.
    // subscribe() delivers state changes directly to this callback WITHOUT causing
    // a React re-render. This is the key performance pattern for the chart.
    unsubscribeRef.current = useTickStore.subscribe(
      (state) => state.latestByCoins[coinId],
      (latestTick) => {
        if (!latestTick || !seriesRef.current) return;

        const point = {
          time: isoToUnixSec(latestTick.polled_at),
          value: latestTick.price_usd,
        };

        // update() is the lightweight-charts incremental update API:
        // it redraws only the affected canvas area, not the full chart.
        seriesRef.current.update(point);
        setHasData(true);

        // Add anomaly marker if flagged
        if (latestTick.is_anomaly) {
          const marker = {
            time: point.time,
            position: "aboveBar",
            color: "hsl(350, 100%, 60%)",
            shape: "arrowDown",
            text: `⚠ ${latestTick.anomaly_score.toFixed(3)}`,
            size: 1,
          };
          // Markers must be set as a full sorted array — lightweight-charts requirement
          markerDataRef.current = [...markerDataRef.current, marker].sort(
            (a, b) => a.time - b.time
          );
          seriesRef.current.setMarkers(markerDataRef.current);
        }
      }
    );

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [coinId]); // Re-run whenever the active coin changes

  return (
    <div className={`live-chart ${className}`} id={`chart-panel-${coinId}`}>
      {/* Loading overlay shown while waiting for first tick */}
      {!hasData && (
        <div className="live-chart__loading">
          <Spinner size="40px" label="Waiting for live data..." />
          <p className="text-sm text-muted" style={{ marginTop: "12px" }}>
            Waiting for first tick…
          </p>
        </div>
      )}
      {/* Canvas container — lightweight-charts mounts here */}
      <div ref={containerRef} className="live-chart__canvas" />
    </div>
  );
}

export default LiveChart;
