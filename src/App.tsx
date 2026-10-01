import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { Navbar } from './components/Layout/Navbar';
import { Home } from './pages/Home';
import { AfterHours } from './pages/AfterHours';
import { Portfolio } from './pages/Portfolio';
import { PickDetail } from './pages/PickDetail';
import { DayTrade } from './pages/DayTrade';
import { NextDay } from './pages/NextDay';
import { MarketRail } from './components/Layout/MarketRail';
import { Settings } from './pages/Settings';

/**
 * Day Trade and the Next-Day Watchlist stay mounted and are only hidden when you visit another
 * page, so their scans, charts and selected stock keep running instead of reloading.
 */
function Shell() {
  const { pathname } = useLocation();
  const onDayTrade = pathname === '/' || pathname === '/daytrade';
  const onWatchlist = pathname === '/watchlist';

  return (
    <div className="min-h-screen bg-surface text-white">
      <Navbar />
      <div className="flex">
        <main className="flex-1 min-w-0">
          <div hidden={!onDayTrade}><DayTrade active={onDayTrade} /></div>
          <div hidden={!onWatchlist}><NextDay active={onWatchlist} /></div>
          <Routes>
            <Route path="/" element={null} />
            <Route path="/daytrade" element={null} />
            <Route path="/watchlist" element={null} />
            <Route path="/chart" element={<Home />} />
            <Route path="/afterhours" element={<AfterHours />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/pick/:ticker" element={<PickDetail />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
        <MarketRail />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Shell />
    </BrowserRouter>
  );
}
