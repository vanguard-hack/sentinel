import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Dashboard from './pages/Dashboard';
import CrimeMap from './pages/CrimeMap';
import CaseFiles from './pages/CaseFiles';
import Reports from './pages/Reports';
import Assistant from './pages/Assistant';
import AIAnalytics from './pages/AIAnalytics';
import LoadingScreen from './components/LoadingScreen';

function AppRoutes() {
  const { loading, signingOut } = useAuth();
  if (signingOut) return <LoadingScreen message="Signing out…" />;
  if (loading) return <LoadingScreen message="Verifying credentials…" />;

  return (
    <Routes>
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/crime-map" element={<CrimeMap />} />
      <Route path="/case-files" element={<CaseFiles />} />
      <Route path="/reports" element={<Reports />} />
      <Route path="/assistant" element={<Assistant />} />
      <Route path="/ai-analytics" element={<AIAnalytics />} />
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
