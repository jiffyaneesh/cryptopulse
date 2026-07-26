/**
 * components/layout/CoinSelector.jsx
 * ────────────────────────────────────
 * Horizontal tab bar for selecting the active tracked coin.
 *
 * Each tab shows:
 *   - Coin symbol (e.g., "BTC").
 *   - Red anomaly badge count if anomalies exist for that coin today.
 *   - Active state with accent gradient underline (framer-motion layoutId).
 *
 * Reads anomaly counts from Zustand store directly (selective subscription —
 * only re-renders when anomalyCounts changes, not on every tick).
 *
 * @module components/layout/CoinSelector
 */

import React from "react";
import { motion } from "framer-motion";
import useTickStore from "../../store/tickStore";

/** Display metadata for each tracked coin. */
const COIN_META = {
  bitcoin:      { symbol: "BTC",  name: "Bitcoin" },
  ethereum:     { symbol: "ETH",  name: "Ethereum" },
  binancecoin:  { symbol: "BNB",  name: "BNB" },
  solana:       { symbol: "SOL",  name: "Solana" },
  cardano:      { symbol: "ADA",  name: "Cardano" },
  ripple:       { symbol: "XRP",  name: "XRP" },
  polkadot:     { symbol: "DOT",  name: "Polkadot" },
  dogecoin:     { symbol: "DOGE", name: "Dogecoin" },
};

/**
 * CoinSelector — Horizontal tab bar for coin selection.
 *
 * @param {object}   props
 * @param {string}   props.activeCoin     - Currently selected coin_id.
 * @param {string[]} props.coins          - List of tracked coin_ids to display.
 * @param {Function} props.onCoinChange   - Callback(coin_id) when tab is clicked.
 * @returns {React.ReactElement}
 */
function CoinSelector({ activeCoin, coins, onCoinChange }) {
  // Selective subscription: only re-render when anomalyCounts map changes
  const anomalyCounts = useTickStore((state) => state.anomalyCounts);

  return (
    <div className="coin-selector" role="tablist" aria-label="Select cryptocurrency">
      {coins.map((coinId) => {
        const meta = COIN_META[coinId] || { symbol: coinId.toUpperCase(), name: coinId };
        const count = anomalyCounts[coinId] || 0;
        const isActive = coinId === activeCoin;

        return (
          <button
            key={coinId}
            role="tab"
            aria-selected={isActive}
            aria-controls={`chart-panel-${coinId}`}
            className={`coin-tab ${isActive ? "coin-tab--active" : ""}`}
            onClick={() => onCoinChange(coinId)}
          >
            {/* Animated active indicator — slides between tabs */}
            {isActive && (
              <motion.div
                className="coin-tab__active-bg"
                layoutId="coin-tab-active"
                transition={{ type: "spring", stiffness: 380, damping: 30 }}
              />
            )}

            <span className="coin-tab__symbol font-semibold">{meta.symbol}</span>
            <span className="coin-tab__name text-xs text-muted">{meta.name}</span>

            {/* Anomaly count badge — only shown when count > 0 */}
            {count > 0 && (
              <motion.span
                className="coin-tab__badge"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 500 }}
              >
                {count > 99 ? "99+" : count}
              </motion.span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default CoinSelector;
