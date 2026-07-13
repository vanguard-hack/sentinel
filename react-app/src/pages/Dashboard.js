import React from 'react';
import { LayoutGrid } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import TopBar from '../components/TopBar';

export default function Dashboard() {
  const { user } = useAuth();
  const { t } = useTranslation();

  const welcomeName =
    user?.first_name ||
    user?.email_id?.split('@')[0] ||
    'Officer';

  return (
    <>
      <TopBar title={<LayoutGrid size={20} strokeWidth={1.8} />} />

      <main className="db-main-content">
        <div className="db-welcome">
          <div className="db-welcome-left">
            <h1 className="db-welcome-title">
              {t('welcome.title')}{' '}
              <span className="db-welcome-name">{welcomeName}</span>
            </h1>
            <p className="db-welcome-sub">{t('welcome.subtitle')}</p>
          </div>
        </div>
      </main>
    </>
  );
}
