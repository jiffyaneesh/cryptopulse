/**
 * components/research/BackToTop.jsx
 * ─────────────────────────────────
 * Floating smooth scroll-to-top button with progress indicator for research pages.
 */

import React, { useState, useEffect } from "react";

export function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function handleScroll() {
      const scrolled = document.documentElement.scrollTop || document.body.scrollTop;
      setVisible(scrolled > 400);
    }

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (!visible) return null;

  return (
    <button
      onClick={scrollToTop}
      aria-label="Scroll back to top"
      style={{
        position: "fixed",
        bottom: "28px",
        right: "28px",
        zIndex: 99,
        background: "rgba(18, 22, 28, 0.9)",
        border: "1px solid rgba(255, 59, 59, 0.4)",
        color: "#fff",
        borderRadius: "4px",
        padding: "8px 14px",
        fontSize: "0.75rem",
        fontFamily: "var(--font-code)",
        cursor: "pointer",
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.6)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        gap: "6px",
        transition: "all 150ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "#ff3b3b";
        e.currentTarget.style.transform = "translateY(-2px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "rgba(255, 59, 59, 0.4)";
        e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      <span>↑</span>
      <span>TOP</span>
    </button>
  );
}

export default BackToTop;
