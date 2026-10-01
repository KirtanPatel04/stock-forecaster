import { useRef, useState, type ReactNode } from 'react';
import { GoalSetupDialog } from '../components/DayTrade/GoalSetupDialog';
import { useDaySession, settingsStore } from '../hooks/useDaySession';
import { usePortfolio } from '../hooks/usePortfolio';
import { usePinnedWatchlist } from '../hooks/usePinnedWatchlist';
import { acctCost, clearJournal, importJournal, journal, useJournal } from '../lib/journal';
import { useFx } from '../lib/fx';
import { DEFAULT_PREFS, prefs, usePrefs, type Prefs } from '../lib/prefs';
import { DEFAULT_SETTINGS } from '../lib/rossRules';

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="bg-panel border border-border rounded-lg">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {subtitle && <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      <div className="p-4 space-y-3 text-xs">{children}</div>
    </section>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start justify-between gap-4 cursor-pointer">
      <span>
        <span className="text-gray-200">{label}</span>
        {hint && <span className="block text-[10px] text-gray-500">{hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={`relative w-9 h-5 rounded-full flex-shrink-0 transition-colors ${checked ? 'bg-accent' : 'bg-gray-700'}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </label>
  );
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-gray-200">{label}</span>
      <div className="flex rounded border border-border overflow-hidden">
        {options.map(([k, text]) => (
          <button key={k} onClick={() => onChange(k)}
            className={`px-2.5 py-1 text-[11px] ${value === k ? 'bg-accent/20 text-accent' : 'text-gray-400 hover:text-gray-200'}`}>{text}</button>
        ))}
      </div>
    </div>
  );
}

/** Everything you can change, in one place. */
export function Settings() {
  const { settings, setSettings } = useDaySession();
  const { portfolio, setCash } = usePortfolio();
  const j = useJournal();
  const [p, setPrefs] = usePrefs();
  const { pins, toggle, clear: clearPins } = usePinnedWatchlist();
  const [pinText, setPinText] = useState('');
  const [notify, setNotify] = useState(() => (typeof Notification !== 'undefined' ? Notification.permission : 'denied'));
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { usdcad } = useFx();
  const openCost = j.open.filter((o) => o.mode !== 'paper').reduce((s, o) => s + acctCost(o, usdcad), 0);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3000); };

  const exportAll = () => {
    const backup = {
      app: 'day-trader', version: 1, exportedAt: new Date().toISOString(),
      journal: journal.get(), plan: settingsStore.get(), prefs: prefs.get(), pins,
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `day-trader-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importAll = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (!window.confirm('Replace your current trades, plan and settings with this backup?')) return;
      if (data.journal) importJournal(data.journal);
      if (data.plan) settingsStore.set(data.plan);
      if (data.prefs) prefs.set(data.prefs as Partial<Prefs>);
      if (Array.isArray(data.pins)) {
        clearPins();
        for (const pin of data.pins) if (pin?.symbol) toggle(String(pin.symbol).toUpperCase());
      }
      flash('✓ Backup restored');
    } catch (e) {
      flash(`Couldn't read that file: ${e instanceof Error ? e.message : 'invalid backup'}`);
    }
  };

  const addPin = () => {
    const sym = pinText.trim().toUpperCase();
    if (sym && !pins.some((x) => x.symbol === sym)) toggle(sym);
    setPinText('');
  };

  return (
    <div className="p-4 max-w-3xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-white">Settings</h1>
        <p className="text-[11px] text-gray-500">Everything you can change in the app. Saved in this browser.</p>
      </div>
      {msg && <div className="text-xs px-3 py-2 rounded border border-accent/40 bg-accent/10 text-accent">{msg}</div>}

      <GoalSetupDialog
        inline open cash={portfolio.cash} openCost={openCost} settings={settings} canClose
        onClose={() => {}}
        onSave={(cash, patch) => { setCash(cash); setSettings(patch); }}
      />

      <Section title="Scanner & game plan" subtitle="Defaults for the Day Trade scanner.">
        <Choice label="Show grades" value={p.scannerGrade} onChange={(v) => setPrefs({ scannerGrade: v })}
          options={[['A', 'A only'], ['AB', 'A + B'], ['all', 'All']]} />
        <Choice label="Sort by" value={p.scannerSort} onChange={(v) => setPrefs({ scannerSort: v })}
          options={[['verdict', 'Buy first'], ['rank', 'Grade'], ['gain', '% gain'], ['potential', '$ to target']]} />
        <Toggle label="Only stocks my cash can size" hint="Hides names too expensive for a proper 2:1 position." checked={p.scannerFitsCash} onChange={(v) => setPrefs({ scannerFitsCash: v })} />
        <Toggle label="Show today's game plan" hint="The picks most likely to hit your daily goal, at the top of the scanner." checked={p.showGamePlan} onChange={(v) => setPrefs({ showGamePlan: v })} />
      </Section>

      <Section title="Alerts" subtitle="Badges on the nav tabs, plus desktop notifications if allowed.">
        <div className="flex items-center justify-between">
          <span className="text-gray-200">Desktop notifications</span>
          {notify === 'granted' ? <span className="text-green-400">On</span>
            : notify === 'denied' ? <span className="text-gray-500">Blocked — allow them in your browser's site settings</span>
            : <button onClick={() => Notification.requestPermission().then(setNotify)} className="px-2.5 py-1 rounded border border-border text-gray-200 hover:border-accent">Enable</button>}
        </div>
        <Toggle label="Market open: my picks for the day" hint="At 7:00 AM (prime window) and 9:30 AM ET — the stocks most likely to hit your goal." checked={p.alertMarketOpen} onChange={(v) => setPrefs({ alertMarketOpen: v })} />
        <Toggle label="New BUY / READY setups" hint="While you're on another page." checked={p.alertNewSetups} onChange={(v) => setPrefs({ alertNewSetups: v })} />
        <Toggle label="New TOP names for tomorrow" hint="From the Next-Day Watchlist." checked={p.alertWatchlistTop} onChange={(v) => setPrefs({ alertWatchlistTop: v })} />
      </Section>

      <Section title="My watchlist" subtitle="Starred stocks are pinned to the top of the Day Trade scanner.">
        <div className="flex gap-2">
          <input value={pinText} onChange={(e) => setPinText(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && addPin()}
            placeholder="Add symbol" className="w-32 bg-surface border border-border rounded px-2 py-1 font-mono text-white focus:outline-none focus:border-accent" />
          <button onClick={addPin} className="px-2.5 py-1 rounded border border-border text-gray-200 hover:border-accent">Add</button>
          {pins.length > 0 && <button onClick={() => window.confirm('Remove all starred stocks?') && clearPins()} className="ml-auto text-gray-500 hover:text-red-400">Clear all</button>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {pins.length === 0 && <span className="text-gray-500">No starred stocks.</span>}
          {pins.map((x) => (
            <span key={x.symbol} className="flex items-center gap-1 px-2 py-0.5 rounded bg-surface border border-border font-mono text-white">
              ★ {x.symbol}<button onClick={() => toggle(x.symbol)} className="text-gray-500 hover:text-red-400">×</button>
            </span>
          ))}
        </div>
        <Toggle label="Show skipped names on the Next-Day Watchlist" checked={p.watchlistShowSkipped} onChange={(v) => setPrefs({ watchlistShowSkipped: v })} />
      </Section>

      <Section title="Layout">
        <Toggle label="Show the Markets rail" hint="Indices and top movers on the right of every page." checked={!p.railCollapsed} onChange={(v) => setPrefs({ railCollapsed: !v })} />
        <Choice label="Markets rail opens on" value={p.railTab} onChange={(v) => setPrefs({ railTab: v })}
          options={[['small_caps', 'Small cap'], ['gainers', 'Gainers'], ['losers', 'Losers'], ['actives', 'Active']]} />
      </Section>

      <Section title="Portfolio" subtitle="What the Portfolio page shows when you open it.">
        <Choice label="Default history" value={p.portfolioRange} onChange={(v) => setPrefs({ portfolioRange: v })}
          options={[['today', 'Day'], ['week', 'Week'], ['month', 'Month'], ['30d', '30D'], ['ytd', 'YTD'], ['all', 'All']]} />
        <Choice label="Default trades" value={p.portfolioMode} onChange={(v) => setPrefs({ portfolioMode: v })}
          options={[['all', 'All'], ['real', 'Real money'], ['paper', 'Paper']]} />
      </Section>

      <Section title="Your data" subtitle={`${j.closed.length} closed trades · ${j.open.length} open positions. Stored only in this browser — back it up.`}>
        <div className="flex flex-wrap gap-2">
          <button onClick={exportAll} className="px-3 py-1.5 rounded bg-accent text-black font-semibold hover:bg-blue-400">Download backup</button>
          <button onClick={() => fileRef.current?.click()} className="px-3 py-1.5 rounded border border-border text-gray-200 hover:border-accent">Restore from backup…</button>
          <input ref={fileRef} type="file" accept="application/json" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importAll(f); e.target.value = ''; }} />
        </div>
        <div className="pt-3 border-t border-border flex flex-wrap gap-2">
          <button onClick={() => { if (window.confirm('Reset scanner, alert, layout and portfolio preferences to defaults?')) { prefs.set(DEFAULT_PREFS); flash('Preferences reset'); } }}
            className="px-3 py-1.5 rounded border border-border text-gray-300 hover:text-white">Reset preferences</button>
          <button onClick={() => { if (window.confirm('Clear your daily plan? You\'ll be asked for it again on the Day Trade page.')) { settingsStore.set(DEFAULT_SETTINGS); flash('Daily plan cleared'); } }}
            className="px-3 py-1.5 rounded border border-border text-gray-300 hover:text-white">Clear daily plan</button>
          <button onClick={() => { if (window.confirm('Delete ALL trades and open positions from your journal? This cannot be undone — download a backup first.')) { clearJournal(); flash('Trade journal cleared'); } }}
            className="px-3 py-1.5 rounded border border-red-500/50 text-red-400 hover:bg-red-500/10">Delete trade history</button>
        </div>
      </Section>
    </div>
  );
}
