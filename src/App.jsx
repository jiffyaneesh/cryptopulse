/**
 * App.jsx
 * ───────
 * Root application component. Provides routing to the Dashboard page.
 *
 * Routes:
 *   /* → Dashboard (all paths show the live dashboard)
 *
 * @module App
 */

import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import ResearchPaper from "./pages/ResearchPaper";
import TheoryDeepDive from "./pages/TheoryDeepDive";
import FeatureStationarity from "./pages/FeatureStationarity";
import SystemArchitecture from "./pages/SystemArchitecture";
import EmpiricalEvaluation from "./pages/EmpiricalEvaluation";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/paper" element={<ResearchPaper />} />
        <Route path="/theory" element={<TheoryDeepDive />} />
        <Route path="/features" element={<FeatureStationarity />} />
        <Route path="/architecture" element={<SystemArchitecture />} />
        <Route path="/evaluation" element={<EmpiricalEvaluation />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
