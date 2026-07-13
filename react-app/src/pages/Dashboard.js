import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Shield, Map, BarChart2, AlertTriangle, MessageSquare,
  Users, Brain, Database, ChevronRight, Search, X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { LANGUAGES } from '../i18n';
import TopBar from '../components/TopBar';

// Each module references a translation key under `modules.*`; labels/descriptions
// are resolved at render time from the active language.
const MODULES = [
  { key: 'incidents',    Icon: AlertTriangle, accent: 'amber', route: '/incidents' },
  { key: 'crimeMap',     Icon: Map,           accent: 'blue', route: '/crime-map' },
  { key: 'aiAnalytics',  Icon: Brain,         accent: 'purple', route: '/ai-analytics' },
  { key: 'reports',      Icon: BarChart2,     accent: 'green', route: '/reports' },
  { key: 'personnel',    Icon: Users,         accent: 'blue'   },
  { key: 'caseFiles',    Icon: Database,      accent: 'green', route: '/case-files' },
  { key: 'assistant',    Icon: MessageSquare, accent: 'amber', route: '/assistant' },
  { key: 'admin',        Icon: Shield,        accent: 'red'    },
];

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
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');

  const welcomeName =
    user?.first_name ||
    user?.email_id?.split('@')[0] ||
    'Officer';

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

  const search = (
    <div className="nav-search">
      <Search size={15} className="nav-search-icon" />
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
  );

  return (
    <>
      <TopBar title="Home" search={search}>
        <div className="nav-lang" role="group" aria-label={t('a11y.language')}>
          {LANGUAGES.map((lng) => (
            <button
              key={lng.code}
              className={`nav-lang-btn ${i18n.resolvedLanguage === lng.code ? 'active' : ''}`}
              onClick={() => i18n.changeLanguage(lng.code)}
              title={lng.name}
              aria-pressed={i18n.resolvedLanguage === lng.code}
            >
              {lng.label}
            </button>
          ))}
        </div>
      </TopBar>

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
    </>
  );
}
