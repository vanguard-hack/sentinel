import React, { useEffect, useState } from 'react';

// Live date and time in the top bar. Sentinel is an operational console — a
// diary entry, an arrest, a custody clock are all recorded against a wall
// time, so the officer should never have to leave the app to check what it is.
//
// IST explicitly, not the browser's zone: every timestamp in the platform is
// Karnataka local time, and a laptop set to another zone would otherwise show
// a clock that disagrees with the records beside it.
const DATE_FMT = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
});
const TIME_FMT = new Intl.DateTimeFormat('en-IN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
});

export default function LiveClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Aligned to the second boundary rather than a bare 1000ms interval, which
    // drifts and makes the seconds visibly stutter.
    let timer;
    const tick = () => {
      setNow(new Date());
      timer = setTimeout(tick, 1000 - (Date.now() % 1000));
    };
    timer = setTimeout(tick, 1000 - (Date.now() % 1000));
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="topbar-clock" title="Current date and time (IST)">
      <span className="topbar-clock-date">{DATE_FMT.format(now)}</span>
      <span className="topbar-clock-time">
        {TIME_FMT.format(now)} <span className="topbar-clock-tz">IST</span>
      </span>
    </div>
  );
}
