"""
scripts/backtest.py
───────────────────
Offline backtesting and evaluation CLI for CryptoPulse anomaly scorers.

Downloads historical Binance 1m klines, replays them tick-by-tick through the
anomaly scoring models, and computes performance metrics (latency, anomaly rate,
score distributions).

Responsibilities:
  - Download and cache historical binance market data.
  - Replay historical data sequentially to simulate a real-time stream.
  - Calculate backtest evaluation metrics and save results.

NOT responsible for:
  - Running live web sockets.
  - Tuning model parameters (this just evaluates fixed parameters).

Usage Examples:
  python scripts/backtest.py --symbol BTCUSDT --days 7 --model zscore --threshold 3.0
  python scripts/backtest.py --symbol ETHUSDT --days 30 --model halftrees --threshold 0.75
  python scripts/backtest.py --symbol BTCUSDT --days 7 --compare
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Make app imports work from CLI
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx

from app.scoring.features import FeatureExtractor
from app.scoring.halftrees import HalfSpaceTreesScorer
from app.scoring.zscore import ZScoreScorer

logger = logging.getLogger(__name__)

# Constants
BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
KLINES_DIR = DATA_DIR / "klines"
RESULTS_DIR = DATA_DIR / "backtest_results"

KLINES_DIR.mkdir(parents=True, exist_ok=True)
RESULTS_DIR.mkdir(parents=True, exist_ok=True)


def download_klines(symbol: str, days: int) -> list[dict[str, Any]]:
    """
    Download or load historical Binance 1m klines.
    
    Args:
        symbol: The trading pair symbol (e.g., 'BTCUSDT').
        days: Number of days of historical data to fetch.
        
    Returns:
        A list of parsed kline dictionaries.
    """
    file_path = KLINES_DIR / f"{symbol}_{days}d_1m.csv"
    
    if file_path.exists():
        logger.info(f"Loading cached klines from {file_path}")
        with open(file_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            return [
                {
                    "open_time": int(row["open_time"]),
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                    "volume": float(row["volume"]),
                    "close_time": int(row["close_time"]),
                }
                for row in reader
            ]

    logger.info(f"Downloading {days} days of 1m klines for {symbol}...")
    
    now_ms = int(time.time() * 1000)
    start_time_ms = now_ms - (days * 24 * 60 * 60 * 1000)
    
    all_klines = []
    
    with httpx.Client() as client:
        while start_time_ms < now_ms:
            params = {
                "symbol": symbol,
                "interval": "1m",
                "limit": 1000,
                "startTime": start_time_ms,
            }
            resp = client.get(BINANCE_KLINES_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
            
            if not data:
                break
                
            for kline in data:
                all_klines.append({
                    "open_time": kline[0],
                    "open": float(kline[1]),
                    "high": float(kline[2]),
                    "low": float(kline[3]),
                    "close": float(kline[4]),
                    "volume": float(kline[5]),
                    "close_time": kline[6],
                })
            
            # Next request starts after the last received kline
            last_close_time = data[-1][6]
            start_time_ms = last_close_time + 1
            
            logger.info(f"Downloaded {len(all_klines)} klines so far...")
            time.sleep(0.1)  # Be nice to Binance rate limits
            
            if len(data) < 1000:
                break
                
    # Save to CSV
    logger.info(f"Saving {len(all_klines)} klines to {file_path}")
    with open(file_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "open_time", "open", "high", "low", "close", "volume", "close_time"
        ])
        writer.writeheader()
        writer.writerows(all_klines)
        
    return all_klines


def compute_stats(values: list[float]) -> dict[str, float]:
    """Compute distribution statistics for a list of values."""
    if not values:
        return {"mean": 0.0, "std": 0.0, "p50": 0.0, "p90": 0.0, "p95": 0.0, "p99": 0.0}
        
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    
    def percentile(p: float) -> float:
        k = (n - 1) * p
        f = int(k)
        c = int(k) + 1 if k > f else f
        if f == c:
            return sorted_vals[f]
        d0 = sorted_vals[f] * (c - k)
        d1 = sorted_vals[c] * (k - f)
        return d0 + d1
        
    mean = statistics.mean(values)
    std = statistics.stdev(values) if n > 1 else 0.0
    
    return {
        "mean": round(mean, 4),
        "std": round(std, 4),
        "p50": round(percentile(0.5), 4),
        "p90": round(percentile(0.9), 4),
        "p95": round(percentile(0.95), 4),
        "p99": round(percentile(0.99), 4),
    }


def compute_lag(anomalies: list[int], returns: list[float]) -> float:
    """
    Compute average detection lag.
    Finds real 5 sigma return spikes and measures ticks until an anomaly is flagged.
    """
    if not anomalies or len(returns) < 100:
        return 0.0
        
    mean_ret = statistics.mean(returns)
    std_ret = statistics.stdev(returns)
    
    if std_ret == 0:
        return 0.0
        
    # Find indices of 5-sigma return spikes
    spikes = [i for i, r in enumerate(returns) if abs(r - mean_ret) > 5 * std_ret]
    
    if not spikes:
        return 0.0
        
    lags = []
    anomaly_set = set(anomalies)
    
    for spike_idx in spikes:
        # Check next 10 ticks for an anomaly
        for offset in range(10):
            if (spike_idx + offset) in anomaly_set:
                lags.append(offset)
                break
                
    if not lags:
        return -1.0  # Missed all spikes
        
    return statistics.mean(lags)


def run_backtest(
    symbol: str,
    klines: list[dict[str, Any]],
    model_name: str,
    threshold: float
) -> dict[str, Any]:
    """
    Run backtest for a specific model over the kline dataset.
    """
    if model_name == "zscore":
        scorer = ZScoreScorer(threshold=threshold)
    elif model_name == "halftrees":
        scorer = HalfSpaceTreesScorer(threshold=threshold)
    else:
        raise ValueError(f"Unknown model: {model_name}")
        
    extractor = FeatureExtractor(window_size=30)

    scores = []
    anomaly_indices = []

    all_rets = []
    all_vols = []
    all_z_rets = []
    all_vol_deltas = []

    for i, kline in enumerate(klines):
        price = kline["close"]
        volume = kline["volume"]

        features = extractor.extract(price, volume)

        # Skip the feature warm-up period: no valid features means nothing to score.
        if features is None:
            continue

        all_rets.append(features["ret"])
        all_vols.append(features["vol"])
        all_z_rets.append(features["z_ret"])
        all_vol_deltas.append(features["vol_delta"])


        # BaseScorer.score() returns a plain (anomaly_score, is_anomaly) tuple.
        anomaly_score, is_anomaly = scorer.score(features)

        scores.append(anomaly_score)
        if is_anomaly:
            # Index into the scored series (NOT the raw kline index i): all_rets,
            # scores and anomaly_indices must share one coordinate system, since
            # compute_lag() and the model-agreement comparison index into them.
            anomaly_indices.append(len(scores) - 1)


    anomaly_rate = len(anomaly_indices) / max(1, len(scores))
    lag = compute_lag(anomaly_indices, all_rets) if all_rets else 0.0
    
    score_stats = compute_stats(scores)
    
    feature_stats = {}
    if all_rets:
        feature_stats = {
            "ret": compute_stats(all_rets),
            "vol": compute_stats(all_vols),
            "z_ret": compute_stats(all_z_rets),
            "vol_delta": compute_stats(all_vol_deltas),
        }
        
    return {
        "model": model_name,
        "threshold": threshold,
        "ticks_processed": len(scores),
        "anomalies_flagged": len(anomaly_indices),
        "anomaly_rate": round(anomaly_rate * 100, 4),
        "detection_lag_ticks": round(lag, 2),
        "score_stats": score_stats,
        "feature_stats": feature_stats,
        "anomaly_indices": anomaly_indices, # Excluded from JSON
    }


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    
    parser = argparse.ArgumentParser(description="CryptoPulse Backtest CLI")
    parser.add_argument("--symbol", type=str, required=True, help="Trading pair symbol (e.g. BTCUSDT)")
    parser.add_argument("--days", type=int, default=7, help="Days of historical data to fetch")
    parser.add_argument("--model", type=str, choices=["zscore", "halftrees"], default="zscore", help="Model to evaluate")
    parser.add_argument("--threshold", type=float, default=3.0, help="Anomaly threshold")
    parser.add_argument("--compare", action="store_true", help="Run both models and compare")
    
    args = parser.parse_args()
    
    klines = download_klines(args.symbol, args.days)
    
    if not klines:
        logger.error("No data fetched.")
        return
        
    models_to_run = ["zscore", "halftrees"] if args.compare else [args.model]
    thresholds = {"zscore": 3.0, "halftrees": 0.75} if args.compare else {args.model: args.threshold}
    
    results = []
    
    print("\n" + "="*80)
    print(f"BACKTEST RESULTS: {args.symbol} ({args.days} days)")
    print("="*80)
    
    for model_name in models_to_run:
        res = run_backtest(args.symbol, klines, model_name, thresholds[model_name])
        results.append(res)
        
        print(f"\nModel: {model_name.upper()}")
        print(f"Threshold: {res['threshold']}")
        print(f"Ticks Processed: {res['ticks_processed']}")
        print(f"Anomalies: {res['anomalies_flagged']} ({res['anomaly_rate']}%)")
        print(f"Detection Lag (ticks): {res['detection_lag_ticks']}")
        
        print("\nScore Stats:")
        for k, v in res['score_stats'].items():
            print(f"  {k}: {v}")
            
    if args.compare and len(results) == 2:
        m1, m2 = results[0], results[1]
        set1 = set(m1["anomaly_indices"])
        set2 = set(m2["anomaly_indices"])
        
        union = set1.union(set2)
        intersection = set1.intersection(set2)
        
        agreement_rate = (len(intersection) / len(union) * 100) if union else 100.0
        
        print("\nCOMPARISON:")
        print(f"Both agreed on {len(intersection)} anomalies.")
        print(f"Agreement Rate (Jaccard): {round(agreement_rate, 2)}%")
        
    # Save to JSON
    timestamp = datetime.now(timezone.utc).isoformat()
    output_data = {
        "timestamp": timestamp,
        "symbol": args.symbol,
        "duration_days": args.days,
        "results": [{k: v for k, v in r.items() if k != "anomaly_indices"} for r in results]
    }
    
    out_file = RESULTS_DIR / f"backtest_{args.symbol}_{int(time.time())}.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(output_data, f, indent=2)
        
    print(f"\nSaved results to {out_file}")

if __name__ == "__main__":
    main()
