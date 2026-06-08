import React from 'react';
import {
  Shield, Map, BarChart2, AlertTriangle, FileText,
  Users, Brain, Database, Bell, LogOut, ChevronRight,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const MODULES = [
  {
    Icon: AlertTriangle,
    label: 'Incidents',
    desc: 'Log, track and manage active crime incidents',
    accent: 'amber',
    status: 'coming-soon',
  },
  {
    Icon: Map,
    label: 'Crime Map',
    desc: 'Geospatial intelligence and hotspot visualisation',
    accent: 'blue',
    status: 'coming-soon',
  },
  {
    Icon: Brain,
    label: 'AI Analytics',
    desc: 'Pattern recognition and predictive crime modelling',
    accent: 'purple',
    status: 'coming-soon',
  },
  {
    Icon: BarChart2,
    label: 'Reports',
    desc: 'Statistical summaries and shift performance data',
    accent: 'green',
    status: 'coming-soon',
  },
  {
    Icon: Users,
    label: 'Personnel',
    desc: 'Officer directory, roles and unit management',
    accent: 'blue',
    status: 'coming-soon',
  },
  {
    Icon: Database,
    label: 'Case Files',
    desc: 'Structured case records and evidence linking',
    accent: 'green',
    status: 'coming-soon',
  },
  {
    Icon: FileText,
    label: 'Intelligence',
    desc: 'Aggregated field intelligence and source reports',
    accent: 'amber',
    status: 'coming-soon',
  },
  {
    Icon: Shield,
    label: 'Admin',
    desc: 'User access control, audit logs and settings',
    accent: 'red',
    status: 'coming-soon',
  },
];

function ModuleCard({ Icon, label, desc, accent }) {
  return (
    <div className={`module-card module-${accent}`}>
      <div className={`module-icon-wrap icon-${accent}`}>
        <Icon size={20} strokeWidth={1.6} />
      </div>
      <div className="module-text">
        <span className="module-label">{label}</span>
        <span className="module-desc">{desc}</span>
      </div>
      <div className="module-arrow">
        <ChevronRight size={16} />
      </div>
      <span className="module-soon-badge">Soon</span>
    </div>
  );
}

export default function Dashboard() {
  const { user, signOut } = useAuth();

  const displayName = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email_id || 'Officer';
  const initials = displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="db-page">

      {/* ── Top navigation bar ── */}
      <header className="db-nav-bar">
        <div className="db-nav-brand">
          <Shield size={20} strokeWidth={1.5} className="nav-brand-icon" />
          <span className="nav-brand-name">SENTINEL</span>
          <span className="nav-brand-rule" />
          <span className="nav-brand-sub">Crime Analytics Platform</span>
        </div>

        <div className="db-nav-right">
          <button className="nav-icon-btn" aria-label="Notifications">
            <Bell size={17} />
          </button>
          <div className="nav-user">
            <div className="nav-avatar">{initials}</div>
            <div className="nav-user-info">
              <span className="nav-user-name">{displayName}</span>
              <span className="nav-user-email">{user?.email_id}</span>
            </div>
          </div>
          <button className="nav-signout-btn" onClick={signOut} title="Sign out">
            <LogOut size={15} />
            <span>Sign out</span>
          </button>
        </div>
      </header>

      {/* ── Main content ── */}
      <main className="db-main-content">

        {/* Welcome */}
        <div className="db-welcome">
          <div className="db-welcome-left">
            <h1 className="db-welcome-title">
              Welcome back, <span className="db-welcome-name">{user?.first_name || 'Officer'}</span>
            </h1>
            <p className="db-welcome-sub">
              Sentinel is your centralised intelligence hub. Select a module below to get started.
            </p>
          </div>
          <div className="db-welcome-badge">
            <div className="db-status-dot" />
            <span>System operational</span>
          </div>
        </div>

        {/* Module grid */}
        <div className="db-section-label">Modules</div>
        <div className="module-grid">
          {MODULES.map((m) => (
            <ModuleCard key={m.label} {...m} />
          ))}
        </div>

      </main>
    </div>
  );
}
