import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Dashboard from './pages/Dashboard';
import LoadingScreen from './components/LoadingScreen';

function AppRoutes() {
  const { loading } = useAuth();
  if (loading) return <LoadingScreen message="Verifying credentials…" />;

  return (
    <Routes>
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Router basename="/app">
        <AppRoutes />
      </Router>
    </AuthProvider>
  );
}
