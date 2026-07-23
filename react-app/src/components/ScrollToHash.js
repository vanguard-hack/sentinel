import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// When a route carries a #hash (from global search deep-links), scroll that
// section into view once it exists. Pages fetch data before rendering their
// charts, so we retry for a short window and briefly highlight the target.
export default function ScrollToHash() {
  const { hash, pathname, search } = useLocation();

  useEffect(() => {
    if (!hash) return undefined;
    const id = decodeURIComponent(hash.slice(1));
    let tries = 0;
    let timer;
    const tryScroll = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('gs-target-flash');
        setTimeout(() => el.classList.remove('gs-target-flash'), 1600);
        return;
      }
      if (tries < 40) { tries += 1; timer = setTimeout(tryScroll, 120); }
    };
    timer = setTimeout(tryScroll, 60);
    return () => clearTimeout(timer);
  }, [hash, pathname, search]);

  return null;
}
