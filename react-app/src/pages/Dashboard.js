import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Shield, Map, BarChart2, AlertTriangle, MessageSquare,
  Users, Brain, Database, Bell, LogOut, ChevronRight,
  Search, Sun, Moon, X, FileText, Gavel, Siren, TrendingUp,
  TrendingDown, RefreshCw, Flame, FolderOpen,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { LANGUAGES } from '../i18n';
import { fetchDashboard } from '../utils/dashboard';
import { BarList, Donut, TrendArea } from '../components/Charts';

// Each module references a translation key under `modules.*`; labels/descriptions
// are resolved at render time from the active language.
const MODULES = [
  { key: 'incidents',    Icon: AlertTriangle, accent: 'amber'  },
  { key: 'crimeMap',     Icon: Map,           accent: 'blue', route: '/crime-map' },
  { key: 'aiAnalytics',  Icon: Brain,         accent: 'purple' },
  { key: 'reports',      Icon: BarChart2,     accent: 'green', route: '/reports' },
  { key: 'personnel',    Icon: Users,         accent: 'blue'   },
  { key: 'caseFiles',    Icon: Database,      accent: 'green', route: '/case-files' },
  { key: 'assistant',    Icon: MessageSquare, accent: 'amber', route: '/assistant' },
  { key: 'admin',        Icon: Shield,        accent: 'red'    },
];

function Kpi({ Icon, label, value, sub, trend }) {
  return (
    <div className="rp-kpi">
      <div className="rp-kpi-icon"><Icon size={18} strokeWidth={1.7} /></div>
      <div className="rp-kpi-body">
        <span className="rp-kpi-value">{value}</span>
        <span className="rp-kpi-label">{label}</span>
        {sub && (
          <span className={`rp-kpi-sub ${trend ? `db-trend-${trend}` : ''}`}>
            {trend === 'up' && <TrendingUp size={11} />}
            {trend === 'down' && <TrendingDown size={11} />}
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}

function Card({ title, subtitle, children }) {
  return (
    <section className="rp-card">
      <div className="rp-card-head">
        <h2 className="rp-card-title">{title}</h2>
        {subtitle && <p className="rp-card-sub">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

const STATUS_TONE = {
  'Under Investigation': 'amber',
  'Charge Sheeted': 'blue',
  'Pending Trial': 'blue',
  Convicted: 'green',
  Acquitted: 'green',
  'Closed - False Case': 'grey',
  'Closed - Undetected': 'grey',
};

function ModuleCard({ Icon, label, desc, accent, soon, onOpen }) {
  const available = typeof onOpen === 'function';
  return (
    <div
      className={`module-card module-${accent} ${available ? 'module-available' : ''}`}
      onClick={available ? onOpen : undefined}
      role={available ? 'button' : undefined}
      tabIndex={available ? 0 : undefined}
      onKeyDown={available ? (e) => { if (e.key === 'Enter' || e.key === ' ') onOpen(); } : undefined}
    >
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
      {!available && <span className="module-soon-badge">{soon}</span>}
    </div>
  );
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [isDark, setIsDark] = useState(
    () => localStorage.getItem('sentinel-theme') === 'dark'
  );

  // Live analytics from the Data Store. Loads after mount; the module grid
  // stays usable even if the Data Store is unreachable (stats simply hide).
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(null);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      setStats(await fetchDashboard());
    } catch (e) {
      setStatsError(e.message || String(e));
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  useEffect(() => {
    const theme = isDark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('sentinel-theme', theme);
  }, [isDark]);

  const displayName =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    user?.email_id ||
    'Officer';

  const welcomeName =
    user?.first_name ||
    user?.email_id?.split('@')[0] ||
    'Officer';

  const initials = displayName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  // Resolve translated text for each module, then filter by the search query.
  const modules = MODULES.map((m) => ({
    ...m,
    label: t(`modules.${m.key}.label`),
    desc: t(`modules.${m.key}.desc`),
  }));

  const q = searchQuery.trim().toLowerCase();
  const filteredModules = q
    ? modules.filter(
        (m) =>
          m.label.toLowerCase().includes(q) || m.desc.toLowerCase().includes(q)
      )
    : modules;

  return (
    <div className="db-page">

      {/* ── Top navigation bar ── */}
      <header className="db-nav-bar">
        <div className="db-nav-brand">
          <Shield size={20} strokeWidth={1.5} className="nav-brand-icon" />
          <span className="nav-brand-name">SENTINEL</span>
          <span className="nav-brand-rule" />
          <span className="nav-brand-sub">{t('nav.subtitle')}</span>
        </div>

        {/* Universal search */}
        <div className="nav-search">
          <Search size={14} className="nav-search-icon" />
          <input
            type="text"
            className="nav-search-input"
            placeholder={t('search.placeholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label={t('search.placeholder')}
          />
          {searchQuery && (
            <button
              className="nav-search-clear"
              onClick={() => setSearchQuery('')}
              aria-label={t('a11y.clearSearch')}
            >
              <X size={13} />
            </button>
          )}
        </div>

        <div className="db-nav-right">
          {/* Language switcher */}
          <div className="nav-lang" role="group" aria-label={t('a11y.language')}>
            {LANGUAGES.map((lng) => (
              <button
                key={lng.code}
                className={`nav-lang-btn ${
                  i18n.resolvedLanguage === lng.code ? 'active' : ''
                }`}
                onClick={() => i18n.changeLanguage(lng.code)}
                title={lng.name}
                aria-pressed={i18n.resolvedLanguage === lng.code}
              >
                {lng.label}
              </button>
            ))}
          </div>

          <button
            className="nav-icon-btn"
            onClick={() => setIsDark((d) => !d)}
            aria-label={isDark ? t('a11y.lightMode') : t('a11y.darkMode')}
            title={isDark ? t('a11y.lightMode') : t('a11y.darkMode')}
          >
            {isDark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button className="nav-icon-btn" aria-label={t('a11y.notifications')}>
            <Bell size={17} />
          </button>
          <div className="nav-user">
            <div className="nav-avatar">{initials}</div>
            <div className="nav-user-info">
              <span className="nav-user-name">{displayName}</span>
              <span className="nav-user-email">{user?.email_id}</span>
            </div>
          </div>
          <button className="nav-signout-btn" onClick={signOut} title={t('action.signOut')}>
            <LogOut size={15} />
            <span>{t('action.signOut')}</span>
          </button>
        </div>
      </header>

      {/* ── Main content ── */}
      <main className="db-main-content">

        {/* Welcome */}
        <div className="db-welcome">
          <div className="db-welcome-left">
            <h1 className="db-welcome-title">
              {t('welcome.title')}{' '}
              <span className="db-welcome-name">{welcomeName}</span>
            </h1>
            <p className="db-welcome-sub">{t('welcome.subtitle')}</p>
          </div>
        </div>

        {/* ── Live analytics (Data Store) ── */}
        <div className="db-analytics">
          <div className="db-section-label db-analytics-label">
            <span>Command Overview</span>
            <button
              className="cf-icon-btn"
              onClick={loadStats}
              title="Refresh analytics"
              disabled={statsLoading}
            >
              <RefreshCw size={14} className={statsLoading ? 'cf-spin' : ''} />
            </button>
          </div>

          {statsError ? (
            <div className="db-analytics-error">
              <AlertTriangle size={16} />
              <span>Analytics unavailable: {statsError}</span>
            </div>
          ) : statsLoading && !stats ? (
            <div className="db-analytics-loading"><div className="cf-spinner" /></div>
          ) : stats && (
            <>
              <div className="rp-kpi-row db-kpi-row">
                <Kpi
                  Icon={FileText}
                  label="Total cases"
                  value={stats.kpis.total.toLocaleString()}
                  sub={
                    stats.kpis.yoyPct == null
                      ? `${stats.kpis.thisYear.toLocaleString()} this year`
                      : `${Math.abs(stats.kpis.yoyPct).toFixed(0)}% YoY (same period)`
                  }
                  trend={
                    stats.kpis.yoyPct == null ? null : stats.kpis.yoyPct >= 0 ? 'up' : 'down'
                  }
                />
                <Kpi
                  Icon={FolderOpen}
                  label="Open investigations"
                  value={stats.kpis.open.toLocaleString()}
                  sub={`${stats.kpis.openPct.toFixed(1)}% of all cases`}
                />
                <Kpi
                  Icon={Gavel}
                  label="Solved rate"
                  value={`${stats.kpis.solvedPct.toFixed(1)}%`}
                  sub="chargesheeted, on trial or decided"
                />
                <Kpi
                  Icon={Flame}
                  label="Heinous share"
                  value={`${stats.kpis.heinousPct.toFixed(1)}%`}
                  sub="of registered cases"
                />
                <Kpi
                  Icon={Siren}
                  label="Arrests & surrenders"
                  value={stats.kpis.arrests.toLocaleString()}
                  sub={`${stats.kpis.chargesheets.toLocaleString()} chargesheets filed`}
                />
              </div>

              <div className="rp-grid db-analytics-grid">
                <Card title="Registration trend" subtitle="FIRs registered per month, last 12 months">
                  <TrendArea data={stats.trend} />
                </Card>
                <Card title="Crime mix" subtitle="Cases by major crime head">
                  <Donut data={stats.byHead} />
                </Card>
                <Card title="Station load" subtitle="Open investigations by police station (top 8)">
                  <BarList data={stats.openByStation} />
                </Card>
                <Card title="Accused age profile" subtitle="Accused on record by age band">
                  <BarList data={stats.accusedAges} />
                </Card>
              </div>

              <Card
                title="Latest FIRs"
                subtitle="Most recently registered cases across the state"
              >
                <div className="cf-scroll">
                  <table className="cf-table db-recent-table">
                    <thead>
                      <tr>
                        <th>Crime No</th><th>Date</th><th>Police station</th>
                        <th>District</th><th>Crime head</th><th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.recent.map((r) => (
                        <tr key={r.crimeNo}>
                          <td className="db-crimeno">
                            {r.crimeNo}
                            {r.heinous && (
                              <span className="db-badge-heinous" title="Heinous offence">
                                <Flame size={11} />
                              </span>
                            )}
                          </td>
                          <td>{r.date}</td>
                          <td>{r.station}</td>
                          <td>{r.district}</td>
                          <td>{r.head}</td>
                          <td>
                            <span className={`db-status db-status-${STATUS_TONE[r.status] || 'grey'}`}>
                              {r.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </div>

        {/* Module grid */}
        <div className="db-section-label">
          {q ? `${t('search.results')} "${searchQuery}"` : t('section.modules')}
        </div>
        <div className="module-grid">
          {filteredModules.length > 0 ? (
            filteredModules.map((m) => (
              <ModuleCard
                key={m.key}
                {...m}
                soon={t('badge.soon')}
                onOpen={m.route ? () => navigate(m.route) : undefined}
              />
            ))
          ) : (
            <p className="module-no-results">
              {t('search.noResults')} <strong>"{searchQuery}"</strong>
            </p>
          )}
        </div>

      </main>
    </div>
  );
}
