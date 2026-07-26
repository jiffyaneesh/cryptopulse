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

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
