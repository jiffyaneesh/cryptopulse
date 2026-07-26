/**
 * components/dashboard/StatsPanel.jsx
 * ─────────────────────────────────────
 * Dashboard statistics panel showing aggregate anomaly detection metrics.
 *
 * Displays:
 *   - Anomalies Today (with percentage rate).
 *   - Throughput (ticks/min over last 5 minutes).
 *   - Model Uptime (since scoring worker started).
 *   - Active Model name.
 *   - Latest tick price for the active coin (from Zustand store).
 *
 * Uses framer-motion AnimatePresence + motion.span for smooth counter
 * transitions when stat values change.
 *
 * Data sources:
 *   - StatsPanel polls the backend via useStats() hook (REST /api/stats).
 *   - Latest price comes from Zustand tickStore (no API call, zero latency).
 *
 * @module components/dashboard/StatsPanel
 */

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import GlassCard from "../ui/GlassCard";
import Badge from "../ui/Badge";
import Spinner from "../ui/Spinner";
import useStats from "../../hooks/useStats";
import useTickStore from "../../store/tickStore";
import { formatThroughput, formatUptime, formatPrice } from "../../utils/formatters";

/**
 * StatRow — Single labelled stat item within the panel.
 *
 * @param {object} props
 * @param {string}          props.label     - Stat label text.
 * @param {string|React.ReactNode} props.value - Formatted stat value.
 * @param {string}          [props.sub]     - Optional secondary/subtitle value.
 * @param {string}          [props.valueClass] - CSS class for value text.
 */
function StatRow({ label, value, sub, valueClass = "" }) {
  return (
    <div className="stat-row">
      <span className="stat-row__label text-xs text-muted">{label}</span>
      <div className="stat-row__value-group">
        <AnimatePresence mode="wait">
          <motion.span
            key={String(value)}
            className={`stat-row__value font-mono font-semibold ${valueClass}`}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.2 }}
          >
            {value}
          </motion.span>
        </AnimatePresence>
        {sub && <span className="stat-row__sub text-xs text-muted">{sub}</span>}
      </div>
    </div>
  );
}

/**
 * StatsPanel — Dashboard aggregate metrics panel.
 *
 * @param {object} props
 * @param {string} props.activeCoin - Currently displayed coin_id (for latest price).
 * @returns {React.ReactElement}
 */
function StatsPanel({ activeCoin }) {
  const { stats, loading, error } = useStats();

  // Latest tick for the active coin — zero-latency from Zustand store
  const latestTick = useTickStore((state) => state.latestByCoins[activeCoin]);

  if (loading && !stats) {
    return (
      <GlassCard title="Statistics" className="stats-panel">
        <div className="stats-panel__loading">
          <Spinner size="24px" label="Loading stats" />
        </div>
      </GlassCard>
    );
  }

  return (
    <GlassCard title="Statistics" className="stats-panel" accentColor="var(--accent-cyan)">
      {/* Latest price — from live WS tick, not REST poll */}
      <div className="stats-panel__price-hero">
        <span className="text-xs text-muted">
          {latestTick?.symbol || activeCoin.toUpperCase()} Price
        </span>
        <AnimatePresence mode="wait">
          <motion.div
            key={latestTick?.price_usd}
            className="stats-panel__price font-mono font-bold gradient-cyan-purple"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.15 }}
          >
            {formatPrice(latestTick?.price_usd)}
          </motion.div>
        </AnimatePresence>

        {/* Anomaly status badge for the latest tick */}
        {latestTick && (
          <Badge
            variant={latestTick.is_anomaly ? "anomaly" : "normal"}
            className="stats-panel__badge"
          />
        )}
      </div>

      <div className="stats-panel__divider" />

      {/* Aggregated stats from REST poll */}
      {error && !stats && (
        <p className="text-xs text-anomaly" style={{ marginBottom: "8px" }}>
          ⚠ Could not reach backend
        </p>
      )}

      <div className="stats-panel__rows">
        <StatRow
          label="Anomalies Today"
          value={stats?.anomalies_today ?? "--"}
          sub={stats ? `${stats.anomaly_rate_pct}% of ticks` : undefined}
          valueClass={stats?.anomalies_today > 0 ? "text-anomaly" : "text-normal"}
        />
        <StatRow
          label="Throughput"
          value={formatThroughput(stats?.throughput_per_minute)}
        />
        <StatRow
          label="Model Uptime"
          value={formatUptime(stats?.model_uptime_seconds)}
        />
        <StatRow
          label="Active Model"
          value={
            stats?.current_model === "halftrees"
              ? "HalfSpaceTrees"
              : stats?.current_model === "zscore"
              ? "Rolling Z-Score"
              : "--"
          }
          valueClass="text-accent"
        />
        <StatRow
          label="WS Clients"
          value={stats?.ws_client_count ?? "--"}
        />
        <StatRow
          label="Threshold"
          value={stats?.current_threshold?.toFixed(2) ?? "--"}
          valueClass="text-secondary"
        />
      </div>
    </GlassCard>
  );
}

export default StatsPanel;
