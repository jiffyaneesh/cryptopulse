/**
 * utils/formatters.js
 * ───────────────────
 * Pure formatting utility functions for the CryptoPulse dashboard.
 *
 * All functions are pure (no side effects, no imports from store/hooks).
 * They transform raw data types into human-readable strings for display.
 *
 * @module utils/formatters
 */

/**
 * Format a price number as a USD currency string.
 *
 * Uses Intl.NumberFormat for locale-aware formatting. Applies smart
 * decimal places: ≥$1 uses 2 decimals; <$1 uses up to 6 decimals
 * to handle micro-cap coins (e.g., DOGE at $0.0823).
 *
 * @param {number}  price     - Price in USD.
 * @param {string}  [currency="USD"] - Currency code for display.
 * @returns {string} Formatted price string (e.g., "$67,423.12").
 */
export function formatPrice(price, currency = "USD") {
  if (price == null || isNaN(price)) return "--";

  const decimals = price >= 1 ? 2 : price >= 0.01 ? 4 : 6;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(price);
}

/**
 * Format a number with compact notation for large values.
 *
 * @param {number} value - Raw numeric value.
 * @returns {string} Compact string (e.g., "$1.23T", "$456.7M", "$78.9K").
 */
export function formatCompact(value) {
  if (value == null || isNaN(value)) return "--";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Format an ISO 8601 timestamp as a relative time string.
 *
 * @param {string} isoString - ISO 8601 UTC datetime string.
 * @returns {string} Relative time string (e.g., "2s ago", "1m ago", "just now").
 */
export function formatRelativeTime(isoString) {
  if (!isoString) return "--";

  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 5)  return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

/**
 * Format a throughput value as "X.X ticks/min".
 *
 * @param {number} ticksPerMin - Ticks per minute value from the backend.
 * @returns {string} Formatted string (e.g., "6.0 ticks/min").
 */
export function formatThroughput(ticksPerMin) {
  if (ticksPerMin == null || isNaN(ticksPerMin)) return "--";
  return `${ticksPerMin.toFixed(1)} ticks/min`;
}

/**
 * Format a duration in seconds as a human-readable uptime string.
 *
 * @param {number} seconds - Duration in seconds.
 * @returns {string} Uptime string (e.g., "2h 34m", "45m 12s", "30s").
 */
export function formatUptime(seconds) {
  if (seconds == null || isNaN(seconds)) return "--";

  const hrs  = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0)  return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

/**
 * Format a percentage change with sign and colour class.
 *
 * @param {number} pct - Percentage change value.
 * @returns {{ text: string, className: string }} Formatted value and CSS class.
 */
export function formatChange(pct) {
  if (pct == null || isNaN(pct)) return { text: "--", className: "text-muted" };

  const sign = pct >= 0 ? "+" : "";
  const text = `${sign}${pct.toFixed(2)}%`;
  const className = pct >= 0 ? "text-normal" : "text-anomaly";
  return { text, className };
}

/**
 * Convert an ISO timestamp to a Unix timestamp in seconds.
 *
 * Used by lightweight-charts which expects time values in Unix seconds
 * (not milliseconds). The chart will render incorrect times if given ms.
 *
 * @param {string} isoString - ISO 8601 UTC string.
 * @returns {number} Unix timestamp in seconds.
 */
export function isoToUnixSec(isoString) {
  return Math.floor(new Date(isoString).getTime() / 1000);
}
