"""Next-day watchlist logic — phases, reverse splits, after-hours / pre-market analysis."""
from datetime import datetime, timezone

import pandas as pd

from app.services.next_day import analyze, is_reverse_split, spike_history, watchlist_phase

NOW = datetime(2026, 9, 30, 22, 0, tzinfo=timezone.utc)   # Wed 6 PM ET


def _bars(start: str, rows: list[tuple]) -> pd.DataFrame:
    idx = pd.date_range(start, periods=len(rows), freq="1min", tz="America/New_York")
    return pd.DataFrame(rows, columns=["open", "high", "low", "close", "volume"], index=idx)


def _session(regular: list[tuple], post: list[tuple]) -> pd.DataFrame:
    parts = [_bars("2026-09-30 09:30", regular)] + ([_bars("2026-09-30 16:00", post)] if post else [])
    return pd.concat(parts)


INFO = {
    "regularMarketPreviousClose": 4.00, "averageDailyVolume3Month": 200_000, "floatShares": 4_000_000,
    "country": "United States", "shortName": "Test Co",
}
NEWS = [{"title": "Test Co announces FDA clearance", "published": "2026-09-30T20:05:00Z"}]


def test_phases():
    at = lambda h: datetime(2026, 9, 30, h, 0, tzinfo=timezone.utc)
    assert watchlist_phase(at(12))["key"] == "premarket"      # 8 AM ET
    assert watchlist_phase(at(15))["key"] == "regular"
    ah = watchlist_phase(at(21))                               # 5 PM ET Wed
    assert ah["key"] == "after_hours" and ah["for_day"] == "Thursday Oct 1"
    fri_night = watchlist_phase(datetime(2026, 10, 3, 1, 0, tzinfo=timezone.utc))   # Fri 9 PM ET
    assert fri_night["key"] == "overnight" and fri_night["for_weekday"] == 0         # → Monday


def test_reverse_split_parsing():
    assert is_reverse_split("1:35")
    assert not is_reverse_split("2:1")
    assert not is_reverse_split(None)


def test_after_hours_news_mover_is_top_of_list():
    regular = [(4.0, 4.05, 3.98, 4.02, 5_000)] * 30
    post = [(4.02, 4.9, 4.0, 4.8, 400_000), (4.8, 5.2, 4.7, 5.0, 900_000)]   # +24% AH on news
    r = analyze("TST", _session(regular, post), INFO, NEWS, None, NOW)
    assert r["kind"] == "after_hours"
    assert round(r["ext_change_pct"]) == 24
    assert r["tier"] == "A"
    assert r["levels"]["ext_high"] == 5.2
    assert "after-hours high $5.2" in r["plan"]


def test_buyout_is_crossed_off():
    regular = [(5.00, 5.02, 4.99, 5.01, 2_000_000)] * 30     # +25% gap then flat all day
    r = analyze("BUY", _session(regular, []), INFO, NEWS, None, NOW)
    assert r["tier"] == "skip"
    assert "buyout" in r["verdict"]


def test_no_news_foreign_small_cap_flagged():
    regular = [(4.0, 6.0, 4.0, 5.9, 500_000)] * 10
    info = {**INFO, "country": "Hong Kong"}
    r = analyze("HK", _session(regular, []), info, [], None, NOW)
    assert any(c["key"] == "pump" and c["status"] == "warn" for c in r["checks"])
    assert r["tier"] in ("B", "C")


def test_premarket_gap_mode():
    pre = _bars("2026-10-01 07:00", [(4.0, 4.6, 4.0, 4.5, 150_000), (4.5, 4.9, 4.45, 4.8, 250_000)])
    info = {**INFO, "marketState": "PRE", "regularMarketPrice": 4.0}
    r = analyze("GAP", pre, info, NEWS, None, datetime(2026, 10, 1, 11, 30, tzinfo=timezone.utc))
    assert r["kind"] == "premarket_gap"
    assert round(r["move_pct"]) == 20
    assert r["levels"]["ext_high"] == 4.9
    assert "Pre-market high $4.9" in r["plan"]


def test_spike_history():
    closes = [2.0] * 20
    df = pd.DataFrame({"open": closes, "high": closes, "low": closes, "close": closes})
    df.loc[5, "high"], df.loc[5, "close"] = 4.0, 2.2    # spiked 100%, faded
    df.loc[12, "high"], df.loc[12, "close"] = 3.5, 2.1
    assert spike_history(df) == 2
