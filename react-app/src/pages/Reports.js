import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Shield, ArrowLeft, Sun, Moon, RefreshCw, AlertTriangle,
  FileText, Users, HeartPulse, PackageCheck,
} from 'lucide-react';
import { fetchReports } from '../utils/reports';
import { BarList, Donut } from '../components/Charts';

function useTheme() {
  const [isDark, setIsDark] = useState(
    () => localStorage.getItem('sentinel-theme') === 'dark'
  );
  useEffect(() => {
    const theme = isDark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('sentinel-theme', theme);
  }, [isDark]);
  return [isDark, setIsDark];
}

function Kpi({ Icon, label, value, sub }) {
  return (
    <div className="rp-kpi">
      <div className="rp-kpi-icon"><Icon size={18} strokeWidth={1.7} /></div>
      <div className="rp-kpi-body">
        <span className="rp-kpi-value">{value}</span>
        <span className="rp-kpi-label">{label}</span>
        {sub && <span className="rp-kpi-sub">{sub}</span>}
      </div>
    </div>
  );
}

function Card({ title, subtitle, children }) {
  return (
    <section className="rp-card">
      <div className="rp-card-head">
        <h2>{title}</h2>
        {subtitle && <span className="rp-card-sub">{subtitle}</span>}
      </div>
      <div className="rp-card-body">{children}</div>
    </section>
  );
}

export default function Reports() {
  const navigate = useNavigate();
  const [isDark, setIsDark] = useTheme();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchReports());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="rp-page">
      <header className="db-nav-bar">
        <div className="db-nav-brand">
          <Shield size={20} strokeWidth={1.5} className="nav-brand-icon" />
          <span className="nav-brand-name">SENTINEL</span>
          <span className="nav-brand-rule" />
          <span className="nav-brand-sub">Reports</span>
        </div>
        <button className="cf-back-btn" onClick={() => navigate('/dashboard')}>
          <ArrowLeft size={15} />
          <span>Dashboard</span>
        </button>
        <div className="db-nav-right">
          <button className="cf-icon-btn" onClick={load} title="Refresh" disabled={loading}>
            <RefreshCw size={15} className={loading ? 'cf-spin' : ''} />
          </button>
          <button
            className="nav-icon-btn"
            onClick={() => setIsDark((d) => !d)}
            title={isDark ? 'Light mode' : 'Dark mode'}
          >
            {isDark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </div>
      </header>

      <main className="rp-main">
        {error ? (
          <div className="cf-state cf-error">
            <AlertTriangle size={22} />
            <p>{error}</p>
            <button className="cf-retry" onClick={load}>Retry</button>
          </div>
        ) : loading || !data ? (
          <div className="cf-state">
            <div className="cf-spinner" />
            <p>Crunching the numbers…</p>
          </div>
        ) : (
          <>
            {/* KPI tiles */}
            <div className="rp-kpi-row">
              <Kpi Icon={FileText} label="FIRs registered" value={data.kpis.firs.toLocaleString()} />
              <Kpi Icon={Users} label="Accused on record" value={data.kpis.accused.toLocaleString()} />
              <Kpi Icon={HeartPulse} label="Victims recorded" value={data.kpis.victims.toLocaleString()} />
              <Kpi
                Icon={PackageCheck}
                label="Chargesheet rate"
                value={`${data.kpis.chargesheetPct.toFixed(1)}%`}
                sub={`${data.kpis.chargesheets.toLocaleString()} of ${data.kpis.firs.toLocaleString()} cases`}
              />
            </div>

            {/* Charts */}
            <div className="rp-grid">
              <Card title="Crime by category" subtitle="FIR classifications by major head">
                <BarList data={data.byCategory} />
              </Card>

              <Card title="Case status" subtitle="Distribution of FIR outcomes">
                <Donut data={data.byStatus} />
              </Card>

              <Card title="Top districts" subtitle="FIRs registered per district">
                <BarList data={data.byDistrict} />
              </Card>

              <Card title="Top crime types" subtitle="Cases by crime sub-head">
                <BarList data={data.bySubHead} />
              </Card>
            </div>

            <p className="rp-footnote">
              Live from the Data Store via ZCQL aggregates over the Police FIR schema.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
