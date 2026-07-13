import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Shield, ArrowLeft, Sun, Moon, Camera, Trash2, Check, AlertTriangle,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import Avatar from '../components/Avatar';
import { getProfile, saveProfile, fileToAvatarDataUrl, cachedPhoto } from '../utils/profile';

function useTheme() {
  const [isDark, setIsDark] = useState(() => localStorage.getItem('sentinel-theme') === 'dark');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    localStorage.setItem('sentinel-theme', isDark ? 'dark' : 'light');
  }, [isDark]);
  return [isDark, setIsDark];
}

const FIELDS = [
  { key: 'displayName', label: 'Full name', placeholder: 'e.g. Inspector R. Gowda' },
  { key: 'badgeNo', label: 'Badge / KGID', placeholder: 'e.g. KGID1234567' },
  { key: 'designation', label: 'Designation', placeholder: 'e.g. Station House Officer' },
  { key: 'department', label: 'Department / Wing', placeholder: 'e.g. Crime Branch' },
  { key: 'station', label: 'Police station / Unit', placeholder: 'e.g. Bengaluru City Market PS' },
  { key: 'phone', label: 'Contact number', placeholder: 'e.g. +91 98xxxxxx' },
];

export default function Profile() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const email = user?.email_id || null;
  const [isDark, setIsDark] = useTheme();

  const [form, setForm] = useState({});
  const [photo, setPhoto] = useState(cachedPhoto());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    let gone = false;
    (async () => {
      const p = email ? await getProfile(email) : {};
      if (gone) return;
      setForm({
        displayName:
          p.displayName ||
          [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
          '',
        badgeNo: p.badgeNo || '',
        designation: p.designation || user?.role_details?.role_name || '',
        department: p.department || '',
        station: p.station || '',
        phone: p.phone || '',
      });
      setPhoto(p.photo || cachedPhoto());
      setLoading(false);
    })();
    return () => { gone = true; };
  }, [email, user]);

  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setSaved(false); };

  const onPhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setPhoto(await fileToAvatarDataUrl(file));
      setSaved(false);
    } catch (err) {
      setError(err.message || 'could not read image');
    }
  };

  const save = useCallback(async () => {
    if (!email) { setError('Not signed in.'); return; }
    setSaving(true);
    setError(null);
    try {
      await saveProfile(email, { ...form, photo: photo || null });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }, [email, form, photo]);

  // A user object for the Avatar preview that ignores the cached photo (we pass
  // the live selection separately).
  const previewUser = { ...user, first_name: form.displayName?.split(' ')[0] };

  return (
    <div className="rp-page">
      <header className="db-nav-bar">
        <div className="db-nav-brand">
          <Shield size={20} strokeWidth={1.5} className="nav-brand-icon" />
          <span className="nav-brand-name">SENTINEL</span>
          <span className="nav-brand-rule" />
          <span className="nav-brand-sub">My Profile</span>
        </div>
        <button className="cf-back-btn" onClick={() => navigate('/dashboard')}>
          <ArrowLeft size={15} /><span>Dashboard</span>
        </button>
        <div className="db-nav-right">
          <button className="nav-icon-btn" onClick={() => setIsDark((d) => !d)} title="Theme">
            {isDark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </div>
      </header>

      <main className="rp-main">
        {loading ? (
          <div className="cf-state"><div className="cf-spinner" /><p>Loading your profile…</p></div>
        ) : (
          <div className="pf-wrap">
            <section className="pf-photo-card">
              <div className="pf-photo">
                {photo ? (
                  <img src={photo} alt="Profile" className="pf-photo-img" />
                ) : (
                  <Avatar user={previewUser} size={120} />
                )}
              </div>
              <div className="pf-photo-actions">
                <button className="cf-export-btn" onClick={() => fileRef.current?.click()}>
                  <Camera size={15} /> Upload photo
                </button>
                {photo && (
                  <button className="pf-photo-remove" onClick={() => { setPhoto(''); setSaved(false); }}>
                    <Trash2 size={14} /> Remove
                  </button>
                )}
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPhoto} />
                <p className="pf-photo-hint">JPG or PNG, squared automatically.</p>
              </div>
            </section>

            <section className="pf-form-card">
              <h2>Personal details</h2>
              <div className="pf-grid">
                {FIELDS.map((f) => (
                  <label key={f.key} className="pf-field">
                    <span>{f.label}</span>
                    <input
                      value={form[f.key] || ''}
                      placeholder={f.placeholder}
                      onChange={(e) => set(f.key, e.target.value)}
                    />
                  </label>
                ))}
                <label className="pf-field pf-field-readonly">
                  <span>Email (from account)</span>
                  <input value={email || ''} disabled />
                </label>
              </div>

              {error && (
                <div className="pf-error"><AlertTriangle size={15} /> {error}</div>
              )}
              <div className="pf-save-row">
                <button className="pf-save" onClick={save} disabled={saving}>
                  {saving ? <span className="btn-spinner" /> : saved ? <Check size={16} /> : null}
                  {saving ? 'Saving' : saved ? 'Saved' : 'Save changes'}
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
