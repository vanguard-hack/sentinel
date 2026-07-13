import ReactDOM from 'react-dom/client';
import './index.css';
import './i18n';
import App from './App';
import reportWebVitals from './reportWebVitals';

// Apply the saved theme before first paint so there's no light flash while the
// shell (which owns the theme toggle) is still mounting.
document.documentElement.setAttribute(
  'data-theme',
  localStorage.getItem('sentinel-theme') === 'dark' ? 'dark' : 'light'
);

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);

reportWebVitals();
