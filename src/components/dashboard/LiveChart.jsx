/**
 * components/dashboard/LiveChart.jsx
 * ────────────────────────────────────
 * Real-time price chart using TradingView's lightweight-charts library.
 */

import React, { useEffect, useRef, useState } from "react";
import { createChart, LineStyle, LineSeries, createSeriesMarkers } from "lightweight-charts";
import useTickStore from "../../store/tickStore";
import { isoToUnixSec, formatPrice } from "../../utils/formatters";
import Spinner from "../ui/Spinner";

function LiveChart({ coinId, className = "" }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const markersApiRef = useRef(null);
  const markerDataRef = useRef([]);
  const unsubscribeRef = useRef(null);
  const [hasData, setHasData] = useState(false);

  // ── Chart initialisation (runs once on mount) ──────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    // Create the chart instance with dark crimson terminal theme
    chartRef.current = createChart(containerRef.current, {
      layout: {
        background: { color: "#050505" },
        textColor: "#a0a0a0",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12,
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
      rightPriceScale: {
        borderColor: "#1a1a1a",
        textColor: "#a0a0a0",
      },
      timeScale: {
        borderColor: "#1a1a1a",
        textColor: "#a0a0a0",
        timeVisible: true,
        secondsVisible: true,
      },
      handleScroll: true,
      handleScale: true,
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 400,
    });

    // Crimson line series for live price data
    seriesRef.current = chartRef.current.addSeries(LineSeries, {
      color: "#ff1a1a",
      lineWidth: 2,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 5,
      crosshairMarkerBorderColor: "#ff3333",
      crosshairMarkerBackgroundColor: "#050505",
      priceLineVisible: true,
      priceLineColor: "rgba(255, 26, 26, 0.4)",
      priceLineWidth: 1,
      priceLineStyle: LineStyle.Dashed,
      lastValueVisible: true,
    });

    // Create the markers plugin API instance for drawing anomalies
    markersApiRef.current = createSeriesMarkers(seriesRef.current, []);

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
  }, []);

  // ── Coin switching: reload history ────────────────────────────────────
  useEffect(() => {
    if (!seriesRef.current) return;

    seriesRef.current.setData([]);
    if (markersApiRef.current) {
      markersApiRef.current.setMarkers([]);
    }
    markerDataRef.current = [];
    setHasData(false);

    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }

    const history = useTickStore.getState().tickHistory[coinId] || [];
    if (history.length > 0) {
      const uniquePoints = new Map();
      history.forEach((t) => {
        const timeSec = isoToUnixSec(t.polled_at);
        uniquePoints.set(timeSec, t.price_usd);
      });

      const points = Array.from(uniquePoints.entries())
        .map(([time, value]) => ({ time, value }))
        .sort((a, b) => a.time - b.time);

      seriesRef.current.setData(points);

      const uniqueMarkers = new Map();
      history
        .filter((t) => t.is_anomaly)
        .forEach((t) => {
          const timeSec = isoToUnixSec(t.polled_at);
          uniqueMarkers.set(timeSec, {
            time: timeSec,
            position: "aboveBar",
            color: "#ff1a1a",
            shape: "arrowDown",
            text: `⚠ ${t.anomaly_score.toFixed(3)}`,
            size: 1,
          });
        });

      const markers = Array.from(uniqueMarkers.values()).sort((a, b) => a.time - b.time);
      markerDataRef.current = markers;
      if (markersApiRef.current) {
        markersApiRef.current.setMarkers(markers);
      }
      setHasData(true);
    }

    unsubscribeRef.current = useTickStore.subscribe(
      (state) => state.latestByCoins[coinId],
      (latestTick) => {
        if (!latestTick || !seriesRef.current) return;

        const point = {
          time: isoToUnixSec(latestTick.polled_at),
          value: latestTick.price_usd,
        };

        seriesRef.current.update(point);
        setHasData(true);

        if (latestTick.is_anomaly) {
          const marker = {
            time: point.time,
            position: "aboveBar",
            color: "#ff1a1a",
            shape: "arrowDown",
            text: `⚠ ${latestTick.anomaly_score.toFixed(3)}`,
            size: 1,
          };
          
          const markersMap = new Map();
          markerDataRef.current.forEach(m => markersMap.set(m.time, m));
          markersMap.set(marker.time, marker);

          const sorted = Array.from(markersMap.values()).sort((a, b) => a.time - b.time);
          markerDataRef.current = sorted;
          if (markersApiRef.current) {
            markersApiRef.current.setMarkers(sorted);
          }
        }
      }
    );

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [coinId]);

  return (
    <div className={`live-chart ${className}`} id={`chart-panel-${coinId}`}>
      {!hasData && (
        <div className="live-chart__loading">
          <Spinner size="30px" label="Waiting for live telemetry stream..." />
          <p className="text-xs text-muted" style={{ marginTop: "8px", fontFamily: "var(--font-mono)" }}>
            AWAITING FIRST TICK STREAM...
          </p>
        </div>
      )}
      <div ref={containerRef} className="live-chart__canvas" />
    </div>
  );
}

export default LiveChart;
