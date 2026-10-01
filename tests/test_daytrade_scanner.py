"""Ross Cameron rule logic — pillars, grading, market temperature, first-pullback detection."""
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from app.services.daytrade_scanner import (
    analyze_setup,
    realistic_targets,
    fast_stop,
    move_profile,
    estimate_minutes,
    evaluate_pillars,
    market_temperature,
    trading_window,
    _catalyst_cutoff,
)


def _bars(rows: list[tuple[float, float, float, float, float]]) -> pd.DataFrame:
    idx = pd.date_range("2026-09-30 07:00", periods=len(rows), freq="1min", tz="America/New_York")
    return pd.DataFrame(rows, columns=["open", "high", "low", "close", "volume"], index=idx)


def _squeeze_then(pullback: list[tuple[float, float, float, float, float]]) -> pd.DataFrame:
    base = [(5.00, 5.02, 4.98, 5.00, 10_000)] * 5
    squeeze = [
        (5.00, 5.40, 5.00, 5.38, 200_000),
        (5.38, 5.80, 5.35, 5.78, 250_000),
        (5.78, 6.20, 5.75, 6.18, 300_000),
        (6.18, 6.50, 6.15, 6.45, 280_000),   # HOD 6.50, move = 1.52
    ]
    return _bars(base + squeeze + pullback)


# ── pillars ──────────────────────────────────────────────────────────────────
def test_all_five_pillars_is_grade_a():
    ev = evaluate_pillars(change_pct=45, rel_volume=12, has_news=True, price=12.0, float_shares=15e6)
    assert ev["score"] == 5
    assert ev["grade"] == "A"


def test_a_plus_needs_sweet_spot_price_low_float_and_prime_window():
    kwargs = dict(change_pct=80, rel_volume=40, has_news=True, price=7.5, float_shares=4e6)
    assert evaluate_pillars(**kwargs, in_prime_window=True)["grade"] == "A+"
    assert evaluate_pillars(**kwargs, in_prime_window=False)["grade"] == "A"


def test_no_news_short_squeeze_is_grade_b():
    ev = evaluate_pillars(change_pct=150, rel_volume=300, has_news=False, price=4.0, float_shares=2e6)
    assert ev["score"] == 4
    assert ev["grade"] == "B"
    assert ev["pillars"]["news"]["pass"] is False


def test_pillar_boundaries():
    ev = evaluate_pillars(change_pct=10, rel_volume=5, has_news=True, price=20, float_shares=19_999_999)
    assert ev["score"] == 5
    ev = evaluate_pillars(change_pct=9.99, rel_volume=4.9, has_news=True, price=20.01, float_shares=20_000_000)
    assert ev["score"] == 1


def test_unknown_float_does_not_pass():
    ev = evaluate_pillars(change_pct=40, rel_volume=10, has_news=True, price=6, float_shares=None)
    assert ev["pillars"]["float"]["pass"] is None
    assert ev["score"] == 4


# ── market temperature ───────────────────────────────────────────────────────
def test_market_temperature():
    hot = [{"change_pct": 120, "rel_volume": 50}, {"change_pct": 200, "rel_volume": 80}]
    assert market_temperature(hot)["key"] == "hot"
    warm = [{"change_pct": 35, "rel_volume": 6}]
    assert market_temperature(warm)["key"] == "warm"
    # Big % move on light relative volume doesn't count as a runner
    cold = [{"change_pct": 90, "rel_volume": 2}, {"change_pct": 15, "rel_volume": 8}]
    assert market_temperature(cold)["key"] == "cold"


# ── time window / catalyst ───────────────────────────────────────────────────
def test_trading_window():
    at = lambda h, m: datetime(2026, 9, 30, h, m, tzinfo=timezone.utc)   # Wed; ET = UTC-4
    assert trading_window(at(10, 30))["key"] == "early"     # 6:30 ET
    assert trading_window(at(11, 15))["key"] == "prime"     # 7:15 ET
    assert trading_window(at(13, 45))["key"] == "prime"     # 9:45 ET
    assert trading_window(at(14, 30))["key"] == "late"      # 10:30 ET
    assert trading_window(at(18, 0))["key"] == "off"        # 2:00 PM ET
    assert trading_window(datetime(2026, 10, 3, 14, 0, tzinfo=timezone.utc))["key"] == "closed"  # Saturday


def test_catalyst_cutoff_is_prior_close_and_weekend_aware():
    wed = _catalyst_cutoff(datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc))
    assert wed == datetime(2026, 9, 29, 20, 0, tzinfo=timezone.utc)   # Tue 4 PM ET
    mon = _catalyst_cutoff(datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc))
    assert mon == datetime(2026, 10, 2, 20, 0, tzinfo=timezone.utc)   # Fri 4 PM ET


# ── first-pullback pattern ───────────────────────────────────────────────────
def test_extended_when_still_squeezing():
    df = _squeeze_then([(6.45, 6.60, 6.44, 6.58, 300_000)])
    s = analyze_setup(df)
    assert s["state"] == "extended"
    assert "entry" not in s


def test_healthy_pullback_gives_entry_stop_target():
    df = _squeeze_then([
        (6.45, 6.46, 6.20, 6.25, 60_000),
        (6.25, 6.28, 6.05, 6.10, 50_000),    # pullback low 6.05 → 30% retrace
        (6.10, 6.12, 6.08, 6.11, 30_000),    # inside candle, no break yet
    ])
    s = analyze_setup(df)
    assert s["state"] == "pullback"
    assert s["hod"] == 6.50
    assert s["entry"] == 6.13                # break of the current candle's high
    assert s["structural_stop"] == 6.05
    # Pullback low is 8¢ away, inside this stock's noise floor (½ avg 1-min range ≈ 10¢) → stop just past noise
    assert s["stop"] == 6.03
    assert s["target"] == 6.33               # 2:1 → 6.13 + 2 × 0.10
    assert s["reach_2r"] == "likely"
    assert s["minutes_2r"] is not None and s["minutes_2r"] <= 30
    assert s["retrace_pct"] < 50
    assert s["checks"]["light_red_volume"]["pass"]


def test_crossing_candle_triggers():
    df = _squeeze_then([
        (6.45, 6.46, 6.20, 6.25, 60_000),
        (6.25, 6.28, 6.05, 6.10, 50_000),
        (6.10, 6.35, 6.09, 6.33, 150_000),   # breaks prior candle high 6.28
    ])
    s = analyze_setup(df)
    assert s["state"] == "triggered"
    assert s["structural_stop"] == 6.05
    assert s["stop"] < s["entry"]


def test_deep_retrace_is_broken():
    df = _squeeze_then([
        (6.45, 6.46, 5.90, 5.95, 200_000),
        (5.95, 5.97, 5.40, 5.45, 250_000),   # >50% of the 1.52 move
    ])
    s = analyze_setup(df)
    assert s["state"] == "broken"


def test_no_data():
    assert analyze_setup(None)["state"] == "none"


# ── fast (≤30 min) 2:1 targets ───────────────────────────────────────────────
PROFILE = {"atr_1m": 0.04, "up30_median": 0.12, "up30_p75": 0.20}


def test_fast_stop_sizes_risk_so_two_r_fits_a_typical_30_min_run():
    # Pullback low 40¢ away, but the stock only runs ~12¢ in 30 min → risk 6¢, target 12¢ away
    stop = fast_stop(entry=5.00, structural_stop=4.60, profile=PROFILE)
    assert stop == 4.94


def test_fast_stop_uses_pullback_low_when_it_is_tighter():
    assert fast_stop(entry=5.00, structural_stop=4.97, profile=PROFILE) == 4.97


def test_fast_stop_never_inside_noise():
    # Pullback low 1¢ away but candles average 4¢ → at least 2¢ of room
    assert fast_stop(entry=5.00, structural_stop=4.99, profile=PROFILE) == 4.98


def test_fast_stop_penny_stock_uses_sub_cent_ticks():
    stop = fast_stop(entry=0.5000, structural_stop=None, profile={"atr_1m": 0.002, "up30_median": 0.01, "up30_p75": 0.02})
    assert stop == 0.495


def test_move_profile_measures_30_min_upside():
    # Steady 1¢/min climb: every 30-min window runs +30¢
    n = 200
    c = 5 + 0.01 * np.arange(n)
    p = move_profile(c + 0.005, c - 0.005, c)
    assert p["samples"] >= 100
    assert abs(p["up30_median"] - 0.305) < 1e-6


def test_estimate_minutes_scales_with_sqrt_time():
    assert estimate_minutes(0.12, PROFILE) == 30
    assert estimate_minutes(0.06, PROFILE) == 8     # half the distance ≈ a quarter of the time


def test_reach_ratings_by_time():
    t = realistic_targets(entry=5.00, stop=4.94, hod=6.00, move=2.0, profile=PROFILE)
    assert t["target"] == 5.12 and t["reach_2r"] == "likely"         # 12¢ = a typical 30-min run
    t = realistic_targets(entry=5.00, stop=4.92, hod=6.00, move=2.0, profile=PROFILE)
    assert t["reach_2r"] == "possible"                                # 16¢ needs a good run
    t = realistic_targets(entry=5.00, stop=4.80, hod=6.00, move=2.0, profile=PROFILE)
    assert t["reach_2r"] == "stretch"                                 # 40¢ in 30 min is unrealistic


def test_target_above_hod_is_at_best_possible():
    t = realistic_targets(entry=5.00, stop=4.97, hod=5.03, move=1.0, profile=PROFILE)
    assert t["reach_2r"] == "possible"


def test_targets_need_positive_risk():
    assert realistic_targets(entry=6.0, stop=6.0, hod=6.5, move=1.0, profile=PROFILE) is None
