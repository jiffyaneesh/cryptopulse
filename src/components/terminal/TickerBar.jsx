/**
 * components/terminal/TickerBar.jsx
 * ───────────────────────────────────
 * Live price ticker with pause/play toggle for the scrolling marquee.
 */

import React, { useState } from "react";
import Tooltip from "../ui/Tooltip";
import useTickStore from "../../store/tickStore";

const COIN_SYMBOLS = {
  bitcoin:     "BTC",
  ethereum:    "ETH",
  binancecoin: "BNB",
  solana:      "SOL",
  cardano:     "ADA",
  ripple:      "XRP",
  polkadot:    "DOT",
  dogecoin:    "DOGE",
};

export default function TickerBar({ coins = [], activeCoin, onSelectCoin }) {
  const [paused, setPaused] = useState(false);

  const latestByCoins = useTickStore((state) => state.latestByCoins);

  const items = coins.map((coinId) => {
    const latest = latestByCoins[coinId];
    const price  = latest ? latest.price_usd : 0;
    const change = latest ? latest.price_change_24h || 0 : 0;
    const symbol = COIN_SYMBOLS[coinId] || coinId.slice(0, 4).toUpperCase();

    return {
      coinId,
      symbol,
      price: price
        ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : "---",
      change,
      isUp: change >= 0,
    };
  });

  // Duplicate for seamless loop
  const marqueeItems = [...items, ...items];

  return (
    <div className="ticker-bar">
      {/* Live status + pause toggle */}
      <div className="ticker-bar__status">
        <span className={`live-dot ${paused ? "live-dot--static" : ""}`} />
        <span>{paused ? "PAUSED" : "LIVE FEED"}</span>
        <Tooltip text={paused ? "Resume ticker scroll" : "Pause ticker scroll"} position="bottom">
          <button
            className="ticker-pause-btn"
            onClick={() => setPaused((p) => !p)}
            aria-label={paused ? "Resume ticker" : "Pause ticker"}
          >
            {paused ? "▶" : "⏸"}
          </button>
        </Tooltip>
      </div>

      {/* Scrolling track */}
      <div className="ticker-bar__scroll-container">
        <div
          className="ticker-bar__track"
          style={{ animationPlayState: paused ? "paused" : "running" }}
        >
          {marqueeItems.map((item, idx) => (
            <Tooltip
              key={`${item.coinId}-${idx}`}
              text={`Click to view ${item.symbol} details. 24h change: ${item.change >= 0 ? "+" : ""}${item.change.toFixed(2)}%`}
              position="bottom"
            >
              <div
                className={`ticker-item ${item.coinId === activeCoin ? "ticker-item--active" : ""}`}
                onClick={() => onSelectCoin(item.coinId)}
                role="button"
                tabIndex={0}
                aria-label={`Select ${item.symbol}`}
                onKeyDown={(e) => e.key === "Enter" && onSelectCoin(item.coinId)}
              >
                <span className="ticker-item__symbol">{item.symbol}</span>
                <span className="ticker-item__price">{item.price}</span>
                <span className={item.isUp ? "text-profit" : "text-loss"}>
                  {item.isUp ? "▲" : "▼"}{Math.abs(item.change).toFixed(2)}%
                </span>
              </div>
            </Tooltip>
          ))}
        </div>
      </div>
    </div>
  );
}
