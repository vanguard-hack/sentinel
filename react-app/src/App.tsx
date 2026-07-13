import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LayoutProvider } from './context/LayoutContext';
import Dashboard from './pages/Dashboard';
import CrimeMap from './pages/CrimeMap';
import CaseFiles from './pages/CaseFiles';
import Reports from './pages/Reports';
import Assistant from './pages/Assistant';
import AIAnalytics from './pages/AIAnalytics';
import Profile from './pages/Profile';
import Incidents from './pages/Incidents';
import Sidebar from './components/Sidebar';
import LoadingScreen from './components/LoadingScreen';
import ErrorBoundary from './components/ErrorBoundary';

function AppRoutes() {
  const { loading, signingOut } = useAuth();
  if (signingOut) return <LoadingScreen message="Signing out…" />;
  if (loading) return <LoadingScreen message="Verifying credentials…" />;

  return (
    <ErrorBoundary>
      <LayoutProvider>
        <div className="app-shell">
          <Sidebar />
          <div className="app-main">
            <Routes>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/crime-map" element={<CrimeMap />} />
              <Route path="/case-files" element={<CaseFiles />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/assistant" element={<Assistant />} />
              <Route path="/ai-analytics" element={<AIAnalytics />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/incidents" element={<Incidents />} />
              <Route path="*" element={<Navigate to="/reports" replace />} />
            </Routes>
          </div>
        </div>
      </LayoutProvider>
    </ErrorBoundary>
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
