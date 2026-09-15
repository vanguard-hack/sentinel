import ReactDOM from 'react-dom/client';
import './index.css';
import './i18n';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { registerServiceWorker } from './utils/offline';

// Apply the saved theme before first paint so there's no light flash while the
// shell (which owns the theme toggle) is still mounting.
document.documentElement.setAttribute(
  'data-theme',
  localStorage.getItem('sentinel-theme') === 'dark' ? 'dark' : 'light'
);

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);

// Offline shell for stations on poor connectivity. Registration is best-effort:
// if the browser refuses (no HTTPS, private mode), the app behaves exactly as
// it did before.
registerServiceWorker();

reportWebVitals();
