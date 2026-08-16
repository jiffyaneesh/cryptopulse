/**
 * components/research/ResearchNav.jsx
 * ───────────────────────────────────
 * Navigation bar for the research and theory portal.
 * Links between the live terminal, research paper, ML theory, feature stationarity,
 * system architecture, and empirical evaluation pages.
 */

import React, { useState, useEffect } from "react";
import { NavLink, Link } from "react-router-dom";

export function ResearchNav() {
  const [scrollProgress, setScrollProgress] = useState(0);

  useEffect(() => {
    function handleScroll() {
      const totalScroll = document.documentElement.scrollTop || document.body.scrollTop;
      const windowHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      if (windowHeight > 0) {
        const progress = Math.min(100, Math.max(0, (totalScroll / windowHeight) * 100));
        setScrollProgress(progress);
      }
    }

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header className="research-nav">
      {/* Scroll Progress Bar */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: `${scrollProgress}%`,
          height: "2px",
          background: "linear-gradient(90deg, #ff1a1a, #ff6666)",
          transition: "width 50ms linear",
          zIndex: 101,
        }}
      />

      <div className="research-nav__inner">
        {/* Left: Brand / Title - Redirects to / */}
        <Link to="/" className="research-nav__brand" title="Return to Live Terminal Dashboard">
          <span>CRYPTOPULSE</span>
          <span className="research-nav__badge">RESEARCH & THEORY</span>
        </Link>

        {/* Center: Navigation Links */}
        <nav className="research-nav__links">
          <NavLink
            to="/paper"
            className={({ isActive }) =>
              `research-nav__link ${isActive ? "active" : ""}`
            }
          >
            <span>📄</span> Whitepaper
          </NavLink>
          <NavLink
            to="/theory"
            className={({ isActive }) =>
              `research-nav__link ${isActive ? "active" : ""}`
            }
          >
            <span>🔬</span> ML Theory
          </NavLink>
          <NavLink
            to="/features"
            className={({ isActive }) =>
              `research-nav__link ${isActive ? "active" : ""}`
            }
          >
            <span>📐</span> Stationarity
          </NavLink>
          <NavLink
            to="/architecture"
            className={({ isActive }) =>
              `research-nav__link ${isActive ? "active" : ""}`
            }
          >
            <span>⚙️</span> Architecture
          </NavLink>
          <NavLink
            to="/evaluation"
            className={({ isActive }) =>
              `research-nav__link ${isActive ? "active" : ""}`
            }
          >
            <span>📊</span> Evaluation
          </NavLink>
        </nav>

        {/* Right: Live Terminal Switch */}
        <div className="research-nav__actions">
          <Link to="/" className="research-nav__btn-live" title="Return to Live Trading Surveillance Terminal">
            <span>●</span> LIVE TERMINAL
          </Link>
        </div>
      </div>
    </header>
  );
}

export default ResearchNav;
