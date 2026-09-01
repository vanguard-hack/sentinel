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
import ReportStudio from './pages/ReportStudio';
import ExportApprovals from './pages/ExportApprovals';
import ExportReview from './pages/ExportReview';
import Assurance from './pages/Assurance';
import ActionQueue from './pages/ActionQueue';
import ReportEditor from './pages/ReportEditor';
import Records from './pages/Records';
import RecordDetail from './pages/RecordDetail';
import HelpCenter from './pages/HelpCenter';
import Custody from './pages/Custody';
import CustodyRecord from './pages/CustodyRecord';
import Sidebar from './components/Sidebar';
import LoadingScreen from './components/LoadingScreen';
import ErrorBoundary from './components/ErrorBoundary';
import RequireAccess from './components/RequireAccess';
import AuditTracker from './components/AuditTracker';
import OfflineBar from './components/OfflineBar';
import ScrollToHash from './components/ScrollToHash';
import { ConfirmProvider } from './components/ConfirmDialog';

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
        <ConfirmProvider>
          <div className="app-shell">
            {/*
              First tab stop on every page. Without it, reaching the content by
              keyboard means tabbing through the whole sidebar on every single
              route — the sort of thing that is invisible to anyone using a
              mouse and exhausting for anyone who isn't.
            */}
            <a className="skip-link" href="#main-content">Skip to main content</a>
            <AuditTracker />
            <ScrollToHash />
            <Sidebar />
            {/*
              tabIndex={-1} makes the target programmatically focusable, so the
              skip link moves FOCUS and not just the scroll position. Left off,
              the link scrolls the page and the next Tab press returns to the
              sidebar, which defeats the point.

              A div rather than <main>: several pages render their own <main>
              landmark, and nesting them would be invalid.
            */}
            <div className="app-main" id="main-content" tabIndex={-1}>
              <OfflineBar />
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
                <Route path="/export-approvals" element={guarded('exportApprovals', <ExportApprovals />)} />
                <Route path="/export-review/:approvalId" element={guarded('exportApprovals', <ExportReview />)} />
                <Route path="/assurance" element={guarded('assurance', <Assurance />)} />
                <Route path="/investigation-diary" element={guarded('investigationDiary', <InvestigationDiary />)} />
                <Route path="/action-queue" element={guarded('actionQueue', <ActionQueue />)} />
                <Route path="/investigation-diary/:caseMasterId" element={guarded('investigationDiary', <InvestigationCase />)} />
                <Route path="/records" element={guarded('records', <Records />)} />
              <Route path="/records/:recordId" element={guarded('records', <RecordDetail />)} />
              <Route path="/report-studio" element={guarded('reportStudio', <ReportStudio />)} />
                <Route path="/report-studio/:reportId" element={guarded('reportStudio', <ReportEditor />)} />
                <Route path="/custody" element={guarded('custody', <Custody />)} />
                <Route path="/custody/:personId" element={guarded('custody', <CustodyRecord />)} />
                <Route path="*" element={<Navigate to="/reports" replace />} />
              </Routes>
            </div>
          </div>
        </ConfirmProvider>
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
