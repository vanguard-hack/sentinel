import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AccessProvider } from './context/AccessContext';
import { LayoutProvider } from './context/LayoutContext';
import Dashboard from './pages/Dashboard';
import CrimeMap from './pages/CrimeMap';
import CaseFiles from './pages/CaseFiles';
import Reports from './pages/Reports';
import Assistant from './pages/Assistant';
import AIAnalytics from './pages/AIAnalytics';
import Profile from './pages/Profile';
import Incidents from './pages/Incidents';
import Personnel from './pages/Personnel';
import Roster from './pages/Roster';
import OrgChart from './pages/OrgChart';
import AccessAudit from './pages/AccessAudit';
import InvestigationDiary from './pages/InvestigationDiary';
import InvestigationCase from './pages/InvestigationCase';
import HelpCenter from './pages/HelpCenter';
import Sidebar from './components/Sidebar';
import LoadingScreen from './components/LoadingScreen';
import ErrorBoundary from './components/ErrorBoundary';
import RequireAccess from './components/RequireAccess';
import AuditTracker from './components/AuditTracker';
import ScrollToHash from './components/ScrollToHash';

// Every feature route is wrapped in a role guard (see utils/access.js for the
// feature → roles matrix) and every route change lands in the audit trail.
const guarded = (feature: string, el: React.ReactNode) => (
  <RequireAccess feature={feature}>{el}</RequireAccess>
);

function AppRoutes() {
  const { loading, signingOut } = useAuth();
  if (signingOut) return <LoadingScreen message="Signing out…" />;
  if (loading) return <LoadingScreen message="Verifying credentials…" />;

  return (
    <ErrorBoundary>
      <LayoutProvider>
        <div className="app-shell">
          <AuditTracker />
          <ScrollToHash />
          <Sidebar />
          <div className="app-main">
            <Routes>
              <Route path="/dashboard" element={guarded('dashboard', <Dashboard />)} />
              <Route path="/crime-map" element={guarded('crimeMap', <CrimeMap />)} />
              <Route path="/case-files" element={guarded('caseFiles', <CaseFiles />)} />
              <Route path="/reports" element={guarded('reports', <Reports />)} />
              <Route path="/assistant" element={guarded('assistant', <Assistant />)} />
              <Route path="/ai-analytics" element={guarded('aiAnalytics', <AIAnalytics />)} />
              <Route path="/profile" element={guarded('profile', <Profile />)} />
              <Route path="/help" element={guarded('help', <HelpCenter />)} />
              <Route path="/incidents" element={guarded('incidents', <Incidents />)} />
              <Route path="/personnel" element={guarded('personnel', <Personnel />)} />
              <Route path="/personnel/roster" element={guarded('dutyRoster', <Roster />)} />
              <Route path="/personnel/org-chart" element={guarded('orgChart', <OrgChart />)} />
              <Route path="/access" element={guarded('access', <AccessAudit />)} />
              <Route path="/investigation-diary" element={guarded('investigationDiary', <InvestigationDiary />)} />
              <Route path="/investigation-diary/:caseMasterId" element={guarded('investigationDiary', <InvestigationCase />)} />
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
      <AccessProvider>
        <Router basename="/app">
          <AppRoutes />
        </Router>
      </AccessProvider>
    </AuthProvider>
  );
}
