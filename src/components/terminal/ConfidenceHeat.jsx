/**
 * components/terminal/ConfidenceHeat.jsx
 * ────────────────────────────────────────
 * Signal confidence bars showing four derived trading signals.
 *
 * Signals
 * ───────
 * HST CONVERGENCE
 *   Live from the scoring model. Measures how far the current tick's anomaly
 *   score is above the configured threshold. 100% = score at or above 1.0
 *   (or threshold for z-score). Meaningful only once the model is warmed up.
 *
 * REALIZED VOLATILITY
 *   Rolling standard deviation of log returns over the last WINDOW ticks,
 *   annualised assuming ~6 ticks/min × 60 × 24 × 365 periods/year.
 *   High % = elevated short-term volatility.
 *   Formula: σ_annual = σ_returns × √(periods_per_year)
 *   Expressed as a percentage of the max observed value in the session
 *   for a 0–100% bar fill.
 *
 * MOMENTUM IGNITION
 *   Least-squares slope of prices over the last WINDOW ticks normalised by
 *   the mean price. A steep upward or downward slope signals a rapid
 *   directional move — potential breakout or breakdown.
 *   Bar fill = |normalised slope| scaled to 0–100%.
 *   Status = BULL when slope > 0, BEAR when < 0, FLAT otherwise.
 *
 * ORDERBOOK IMBALANCE
 *   Real bid/ask spread-based proxy: widening spread indicates imbalance
 *   between buyers and sellers. Uses bid_price/ask_price from the live tick.
 *   Displayed as spread % relative to a rolling max spread for bar scaling.
 *
 * All four signals are fully reactive to live WS ticks via Zustand selectors.
 */

import React, { useMemo } from "react";
import PanelFrame from "../layout/PanelFrame";
import Tooltip from "../ui/Tooltip";
import useTickStore from "../../store/tickStore";

// ── Configuration ────────────────────────────────────────────────────────────
/** Number of ticks to use for rolling signal calculations. */
const WINDOW = 20;

/**
 * Binance polls roughly every 10 seconds. 6 ticks/min × 60 × 24 × 365 gives
 * the annualisation factor for realised volatility.
 * Using 52560 (≈ 10s poll × 6/min × 525,600 min/year).
 */
const TICKS_PER_YEAR = 52_560;

const SIGNAL_TOOLTIPS = {
  "HST CONVERGENCE": (
    "HalfSpaceTrees model confidence. High % = anomaly score far above threshold. " +
    "Updates on every live tick once the model has warmed up (~50 ticks per coin)."
  ),
  "REALIZED VOL": (
    `Rolling annualised realised volatility from log-returns over the last ${WINDOW} ticks. ` +
    "High % = elevated short-term price variability. " +
    "Computed as σ(log returns) × √(ticks_per_year)."
  ),
  "MOMENTUM": (
    `Least-squares price slope over the last ${WINDOW} ticks, normalised by mean price. ` +
    "Bar = magnitude. BULL = upward slope, BEAR = downward slope, FLAT = near-zero. " +
    "Sudden high values indicate rapid directional moves."
  ),
  "SPREAD PROXY": (
    "Real-time bid/ask spread as a percentage of the mid-price, scaled relative " +
    "to recent session maximum. Widening spread = increasing imbalance or illiquidity."
  ),
};

const STATUS_COLORS = {
  ALERT:  "var(--accent)",
  BULL:   "var(--color-profit)",
  BEAR:   "var(--accent)",
  FLAT:   "var(--text-secondary)",
  ACTIVE: "var(--color-warning)",
  STABLE: "var(--color-profit)",
  LOW:    "var(--text-muted)",
  HIGH:   "var(--accent)",
};

// ── Signal computation helpers ────────────────────────────────────────────────

/**
 * Compute realised volatility (annualised %) from the last N ticks.
 *
 * @param {number[]} prices - Array of price_usd values, oldest-first.
 * @returns {{ vol: number, fill: number }} vol in %, fill 0–100.
 */
function computeRealizedVol(prices) {
  if (prices.length < 2) return { vol: 0, fill: 0 };

  const window = prices.slice(-WINDOW);
  if (window.length < 2) return { vol: 0, fill: 0 };

  // Log returns: r_i = ln(P_i / P_{i-1})
  const returns = [];
  for (let i = 1; i < window.length; i++) {
    if (window[i - 1] > 0 && window[i] > 0) {
      returns.push(Math.log(window[i] / window[i - 1]));
    }
  }
  if (returns.length === 0) return { vol: 0, fill: 0 };

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Annualise: σ_annual = σ_tick × √(ticks_per_year)
  const annualised = stdDev * Math.sqrt(TICKS_PER_YEAR) * 100; // as %

  // Scale fill: 100% fill = 200% annualised vol (extreme volatility cap)
  const fill = Math.min(100, (annualised / 200) * 100);
  return { vol: annualised, fill };
}

/**
 * Compute normalised price momentum (least-squares slope / mean price).
 *
 * Returns the slope sign, relative slope magnitude as 0–100 fill, and
 * a BULL / BEAR / FLAT status string.
 *
 * @param {number[]} prices - Array of price_usd values, oldest-first.
 * @returns {{ slopePct: number, fill: number, status: string }}
 */
function computeMomentum(prices) {
  if (prices.length < 2) return { slopePct: 0, fill: 0, status: "FLAT" };

  const window = prices.slice(-WINDOW);
  const n = window.length;
  if (n < 2) return { slopePct: 0, fill: 0, status: "FLAT" };

  // Ordinary least squares: slope = (n·Σxy − Σx·Σy) / (n·Σx² − (Σx)²)
  // where x = tick index (0..n-1), y = price
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX  += i;
    sumY  += window[i];
    sumXY += i * window[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slopePct: 0, fill: 0, status: "FLAT" };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const meanPrice = sumY / n;

  // Normalise slope by mean price to get a unit-free momentum measure.
  // Multiply by WINDOW to express it as total % move over the window.
  const normSlope = meanPrice > 0 ? (slope / meanPrice) * WINDOW * 100 : 0;

  // Fill = magnitude, capped at 100 (10% directional move = 100% fill)
  const fill = Math.min(100, Math.abs(normSlope) * 10);

  const status =
    normSlope > 0.2  ? "BULL" :
    normSlope < -0.2 ? "BEAR" :
    "FLAT";

  return { slopePct: normSlope, fill, status };
}

/**
 * Compute spread proxy fill from bid/ask prices.
 *
 * @param {number} bid           - Best bid price.
 * @param {number} ask           - Best ask price.
 * @param {number} maxSpreadPct  - Session maximum spread % for normalisation.
 * @returns {{ spreadPct: number, fill: number }}
 */
function computeSpreadProxy(bid, ask, maxSpreadPct) {
  if (!bid || !ask || ask <= bid) return { spreadPct: 0, fill: 0 };
  const mid = (bid + ask) / 2;
  const spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : 0;
  // Normalise to session max for relative fill
  const fill = maxSpreadPct > 0
    ? Math.min(100, (spreadPct / maxSpreadPct) * 100)
    : Math.min(100, spreadPct * 1000); // fallback: 0.1% spread = 100% fill
  return { spreadPct, fill };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ConfidenceHeat({ activeCoin }) {
  const latest = useTickStore((state) => state.latestByCoins[activeCoin]);

  /**
   * Subscribe to the last WINDOW+1 price values for this coin.
   * Using a memoised selector so we only re-render when the visible
   * price window changes, not when other coins receive ticks.
   */
  const recentPrices = useTickStore(
    useMemo(
      () => (state) =>
        (state.tickHistory[activeCoin] ?? [])
          .slice(-(WINDOW + 1))
          .map((t) => t.price_usd),
      [activeCoin]
    )
  );

  /**
   * Track session-maximum spread % for relative normalisation.
   * We derive this by watching the latest tick's spread inline — using a
   * ref for this kind of accumulation is an alternative, but a useMemo over
   * the window is cleaner and avoids stale-closure issues.
   */
  const maxSpreadPct = useTickStore(
    useMemo(
      () => (state) => {
        const history = state.tickHistory[activeCoin] ?? [];
        let max = 0;
        for (const t of history) {
          if (t.bid_price && t.ask_price) {
            const mid = (t.bid_price + t.ask_price) / 2;
            if (mid > 0) {
              const s = ((t.ask_price - t.bid_price) / mid) * 100;
              if (s > max) max = s;
            }
          }
        }
        return max;
      },
      [activeCoin]
    )
  );

  // ── Derived signal values ──────────────────────────────────────────────────
  const score     = latest ? latest.anomaly_score || 0 : 0;
  const isAnomaly = latest?.is_anomaly || false;

  const { vol: annualisedVol, fill: volFill } = useMemo(
    () => computeRealizedVol(recentPrices),
    [recentPrices]
  );

  const { slopePct, fill: momentumFill, status: momentumStatus } = useMemo(
    () => computeMomentum(recentPrices),
    [recentPrices]
  );

  const { spreadPct, fill: spreadFill } = useMemo(
    () => computeSpreadProxy(
      latest?.bid_price ?? 0,
      latest?.ask_price ?? 0,
      maxSpreadPct
    ),
    [latest?.bid_price, latest?.ask_price, maxSpreadPct]
  );

  const signals = [
    {
      name:    "HST CONVERGENCE",
      val:     `${(score * 100).toFixed(1)}%`,
      fill:    Math.min(100, Math.max(5, score * 100)),
      status:  isAnomaly ? "ALERT" : "STABLE",
      isHigh:  score > 0.8,
      live:    true,
    },
    {
      name:   "REALIZED VOL",
      // Display as annualised % with 1 decimal place
      val:    recentPrices.length >= 2 ? `${annualisedVol.toFixed(1)}%/yr` : "---",
      fill:   volFill,
      status: volFill > 70 ? "HIGH" : "ACTIVE",
      isHigh: volFill > 70,
      live:   recentPrices.length >= 2,
    },
    {
      name:   "MOMENTUM",
      // Show normalised slope with sign: "+1.23%" or "-0.45%"
      val:    recentPrices.length >= 2
        ? `${slopePct >= 0 ? "+" : ""}${slopePct.toFixed(2)}%`
        : "---",
      fill:   momentumFill,
      status: momentumStatus,
      isHigh: momentumFill > 60,
      live:   recentPrices.length >= 2,
    },
    {
      name:   "SPREAD PROXY",
      val:    spreadPct > 0 ? `${spreadPct.toFixed(4)}%` : "---",
      fill:   spreadFill,
      status: spreadFill > 70 ? "ALERT" : "ACTIVE",
      isHigh: spreadFill > 70,
      live:   !!(latest?.bid_price && latest?.ask_price),
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
                <Tooltip text={SIGNAL_TOOLTIPS[sig.name]} position="left" maxWidth="260px">
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
                  <span
                    className={`confidence-item__val ${
                      sig.isHigh ? "text-loss glow-red-text" :
                      sig.live    ? "text-profit" :
                      "text-muted"
                    }`}
                  >
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
            </div>
          );
        })}
      </div>
    </PanelFrame>
  );
}
