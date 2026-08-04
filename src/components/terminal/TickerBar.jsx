import React from "react";
import useTickStore from "../../store/tickStore";

const COIN_SYMBOLS = {
  bitcoin: "BTC",
  ethereum: "ETH",
  binancecoin: "BNB",
  solana: "SOL",
  cardano: "ADA",
  ripple: "XRP",
  polkadot: "DOT",
  dogecoin: "DOGE",
};

export default function TickerBar({ coins = [], activeCoin, onSelectCoin }) {
  const tickHistory = useTickStore((state) => state.tickHistory);

  // Get current snapshot details per coin
  const items = coins.map((coinId) => {
    const history = tickHistory[coinId] || [];
    const latest = history[history.length - 1];
    const price = latest ? latest.price_usd : 0;
    const change = latest ? latest.price_change_24h || 0 : 0;
    const symbol = COIN_SYMBOLS[coinId] || coinId.slice(0, 4).toUpperCase();

    return {
      coinId,
      symbol,
      price: price ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "---",
      change,
      isUp: change >= 0,
    };
  });

  // Duplicate items array to create seamless infinite marquee effect
  const marqueeItems = [...items, ...items];

  return (
    <div className="ticker-bar">
      <div className="ticker-bar__status">
        <span className="live-dot"></span>
        <span>LIVE FEED</span>
      </div>
      <div className="ticker-bar__scroll-container">
        <div className="ticker-bar__track">
          {marqueeItems.map((item, idx) => (
            <div
              key={`${item.coinId}-${idx}`}
              className={`ticker-item ${item.coinId === activeCoin ? "ticker-item--active" : ""}`}
              onClick={() => onSelectCoin(item.coinId)}
            >
              <span className="ticker-item__symbol">{item.symbol}</span>
              <span className="ticker-item__price">{item.price}</span>
              <span className={item.isUp ? "text-profit" : "text-loss"}>
                {item.isUp ? "▲" : "▼"}
                {Math.abs(item.change).toFixed(2)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
