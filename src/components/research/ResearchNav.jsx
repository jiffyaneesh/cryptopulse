/**
 * components/research/ResearchNav.jsx
 * ───────────────────────────────────
 * Navigation bar for the research and theory portal.
 * Links between the live terminal, research paper, ML theory, feature stationarity,
 * system architecture, and empirical evaluation pages.
 */

import React from "react";
import { NavLink, Link } from "react-router-dom";

export function ResearchNav() {
  return (
    <header className="research-nav">
      <div className="research-nav__inner">
        {/* Left: Brand / Title */}
        <Link to="/paper" className="research-nav__brand">
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
