import React, { useState, useEffect, useCallback } from 'react';
import { Check, AlertTriangle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import Avatar from '../components/Avatar';
import TopBar from '../components/TopBar';
import { getProfile, saveProfile } from '../utils/profile';

const FIELDS = [
  { key: 'displayName', label: 'Full name', placeholder: 'e.g. Inspector R. Gowda' },
  { key: 'badgeNo', label: 'Badge / KGID', placeholder: 'e.g. KGID1234567' },
  { key: 'designation', label: 'Designation', placeholder: 'e.g. Station House Officer' },
  { key: 'department', label: 'Department / Wing', placeholder: 'e.g. Crime Branch' },
  { key: 'station', label: 'Police station / Unit', placeholder: 'e.g. Bengaluru City Market PS' },
  { key: 'phone', label: 'Contact number', placeholder: 'e.g. +91 98xxxxxx' },
];

export default function Profile() {
  const { user } = useAuth();
  const email = user?.email_id || null;

  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

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
      setLoading(false);
    })();
    return () => { gone = true; };
  }, [email, user]);

  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setSaved(false); };

  const save = useCallback(async () => {
    if (!email) { setError('Not signed in.'); return; }
    setSaving(true);
    setError(null);
    try {
      await saveProfile(email, form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }, [email, form]);

  const previewUser = { ...user, first_name: form.displayName?.split(' ')[0] };

  return (
    <div className="rp-page">
      <TopBar title="My Profile" subtitle="Your account details" />

      <main className="rp-main">
        {loading ? (
          <div className="cf-state"><div className="cf-spinner" /><p>Loading your profile…</p></div>
        ) : (
          <div className="pf-wrap">
            <section className="pf-photo-card">
              <div className="pf-photo">
                <Avatar user={previewUser} size={120} />
              </div>
              <div className="pf-identity">
                <span className="pf-identity-name">{form.displayName || 'Officer'}</span>
                <span className="pf-identity-email">{email}</span>
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
