import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Shield, Map, BarChart2, AlertTriangle, FileText,
  Users, Brain, Database, Bell, LogOut, ChevronRight,
  Search, Sun, Moon, X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { LANGUAGES } from '../i18n';

// Each module references a translation key under `modules.*`; labels/descriptions
// are resolved at render time from the active language.
const MODULES = [
  { key: 'incidents',    Icon: AlertTriangle, accent: 'amber'  },
  { key: 'crimeMap',     Icon: Map,           accent: 'blue'   },
  { key: 'aiAnalytics',  Icon: Brain,         accent: 'purple' },
  { key: 'reports',      Icon: BarChart2,     accent: 'green'  },
  { key: 'personnel',    Icon: Users,         accent: 'blue'   },
  { key: 'caseFiles',    Icon: Database,      accent: 'green'  },
  { key: 'intelligence', Icon: FileText,      accent: 'amber'  },
  { key: 'admin',        Icon: Shield,        accent: 'red'    },
];

function ModuleCard({ Icon, label, desc, accent, soon }) {
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
      <span className="module-soon-badge">{soon}</span>
    </div>
  );
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const { t, i18n } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [isDark, setIsDark] = useState(
    () => localStorage.getItem('sentinel-theme') === 'dark'
  );

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
          <div className="db-welcome-badge">
            <div className="db-status-dot" />
            <span>{t('system.operational')}</span>
          </div>
        </div>

        {/* Module grid */}
        <div className="db-section-label">
          {q ? `${t('search.results')} "${searchQuery}"` : t('section.modules')}
        </div>
        <div className="module-grid">
          {filteredModules.length > 0 ? (
            filteredModules.map((m) => (
              <ModuleCard key={m.key} {...m} soon={t('badge.soon')} />
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
