import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAlerts, type AlertPage } from '../../lib/alerts';
import { layouts, useLayouts, type LayoutPage } from '../../lib/layouts';

// Day trading first — the rest are supporting research tools
const primary = [
  { to: '/', label: 'Day Trade', match: ['/', '/daytrade'], alert: 'daytrade' as AlertPage },
  { to: '/watchlist', label: 'Next-Day Watchlist', match: ['/watchlist'], alert: 'watchlist' as AlertPage },
];

const tools = [
  { to: '/chart', label: 'Chart' },
  { to: '/afterhours', label: 'AI Report' },
  { to: '/portfolio', label: 'Portfolio' },
];

function etClock(): string {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
}

export function Navbar() {
  const { pathname } = useLocation();
  const [clock, setClock] = useState(etClock);
  const pending = useAlerts();
  const { editing } = useLayouts();
  // Leaving a page ends layout editing
  useEffect(() => { layouts.setEditing(null); }, [pathname]);
  const layoutPage: LayoutPage | null = pathname === '/' || pathname === '/daytrade' ? 'daytrade' : pathname === '/watchlist' ? 'watchlist' : null;
  const [notify, setNotify] = useState(() => typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  useEffect(() => {
    const id = setInterval(() => setClock(etClock()), 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <nav className="h-12 bg-panel border-b border-border px-6 flex items-center gap-6 sticky top-0 z-20">
      <span className="text-accent font-semibold text-sm tracking-wider font-mono mr-2">DAY TRADER</span>
      {primary.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className={`text-sm font-semibold transition-colors ${
            item.match.includes(pathname)
              ? 'text-white border-b-2 border-accent pb-0.5'
              : 'text-gray-300 hover:text-white'
          }`}
        >
          <span className="relative">
            {item.label}
            {pending[item.alert].length > 0 && (
              <span title={pending[item.alert].map((a) => `${a.symbol} ${a.label}`).join(', ')}
                className="absolute -top-2 -right-4 min-w-[16px] h-4 px-1 rounded-full bg-green-500 text-black text-[10px] font-bold flex items-center justify-center">
                {pending[item.alert].length}
              </span>
            )}
          </span>
        </Link>
      ))}
      <span className="w-px h-5 bg-border" />
      {tools.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className={`text-xs transition-colors ${
            pathname === item.to ? 'text-white border-b-2 border-accent pb-0.5' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          {item.label}
        </Link>
      ))}
      {notify === 'default' && (
        <button onClick={() => Notification.requestPermission().then(setNotify)}
          className="ml-auto text-[11px] text-gray-400 hover:text-white border border-border rounded px-2 py-0.5">
          🔔 Alert me on new setups
        </button>
      )}
      <span className={`${notify === 'default' ? '' : 'ml-auto '}text-[11px] font-mono text-gray-500`} title="Eastern Time — the market's clock">
        {clock} ET
      </span>
      {layoutPage && (
        <button onClick={() => layouts.setEditing(editing === layoutPage ? null : layoutPage)}
          title="Move, resize, hide or show the panels on this page"
          className={`text-[11px] px-2 py-0.5 rounded border ${editing === layoutPage ? 'border-accent bg-accent/20 text-accent' : 'border-border text-gray-400 hover:text-white'}`}>
          ⊞ {editing === layoutPage ? 'Editing layout' : 'Edit layout'}
        </button>
      )}
      <Link to="/settings" title="Settings"
        className={`text-sm ${pathname === '/settings' ? 'text-white' : 'text-gray-500 hover:text-gray-200'}`}>⚙ Settings</Link>
    </nav>
  );
}
