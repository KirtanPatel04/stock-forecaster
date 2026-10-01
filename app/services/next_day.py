"""Next-day watchlist — Ross Cameron's after-hours → pre-market routine.

After the close he pulls up the after-hours top-gainer scanner (4–8 PM ET) plus the
day's leading gainers; at 6:45–7 AM he checks the pre-market gappers. For every name:
float, price, relative volume, country and catalyst, then the daily chart (200 MA
overhead? history of spiking and fading?). He crosses off buyouts (trading flat),
is skeptical of no-news Chinese small caps (pump groups), likes recent reverse
splits with news, doesn't marry stocks that closed red, and notes that Mondays
tend to be strongest and Fridays weakest.

See `.claude/skills/ross-cameron-day-trading/SKILL.md` → "After hours → next day".
"""
import logging
from datetime import datetime, time as dtime, timedelta, timezone
from typing import Optional

import numpy as np
import pandas as pd
import yfinance as yf

from .daytrade_scanner import (
    ET, MAX_FLOAT, MIN_PRICE, MAX_PRICE, MIN_REL_VOLUME, MIN_CHANGE_PCT,
    _alpaca_gainers, _cached, _catalyst_cutoff, _info, _news, _round_px, _screen_universe, _today_bars,
    market_session, nasdaq_gainers,
)

logger = logging.getLogger(__name__)

REGULAR_OPEN, REGULAR_CLOSE = dtime(9, 30), dtime(16, 0)
MIN_EXT_VOLUME = 100_000
PUMP_RISK_COUNTRIES = {"China", "Hong Kong", "Macau", "Macao", "Singapore", "Malaysia", "Taiwan"}
REVERSE_SPLIT_DAYS = 120
RECENT_IPO_DAYS = 180


# ── phase / calendar ─────────────────────────────────────────────────────────
def next_trading_day(d: datetime) -> datetime:
    d = d + timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def watchlist_phase(now: Optional[datetime] = None) -> dict:
    now_et = (now or datetime.now(timezone.utc)).astimezone(ET)
    mins = now_et.hour * 60 + now_et.minute
    weekday = now_et.weekday() < 5
    if weekday and 4 * 60 <= mins < 9 * 60 + 30:
        key, label, target = "premarket", "Pre-market gappers — Ross checks these at 6:45–7:00 AM", now_et
    elif weekday and 9 * 60 + 30 <= mins < 16 * 60:
        key, label, target = "regular", "Market open — tonight's list builds from today's runners and after-hours news at 4 PM", next_trading_day(now_et)
    elif weekday and 16 * 60 <= mins < 20 * 60:
        key, label, target = "after_hours", "After hours — the after-hours top gainers are tomorrow's candidates", next_trading_day(now_et)
    else:
        # Overnight / weekend: tomorrow morning, or Monday
        target = now_et if (weekday and mins < 4 * 60) else next_trading_day(now_et)
        key, label = "overnight", "Final watchlist — re-check at 7 AM for fresh pre-market news"
    return {"key": key, "label": label, "for_day": target.strftime("%A %b %-d"), "for_weekday": target.weekday()}


def session_notes(phase: dict, now: Optional[datetime] = None) -> list[str]:
    now_et = (now or datetime.now(timezone.utc)).astimezone(ET)
    notes = []
    wd = phase["for_weekday"]
    if wd == 0:
        notes.append("Monday — companies prefer to release good news early in the week; Mondays have been his strongest day.")
    elif wd == 4:
        notes.append("Friday — good headlines are rarer and follow-through is weaker. Keep size down, walk away early.")
    if now_et.month in (3, 6, 9, 12) and now_et.day >= 24 or now_et.month in (1, 4, 7, 10) and now_et.day <= 7:
        notes.append("Quarter-end — companies raise cash: expect more offerings that knock runners back down.")
    return notes


# ── per-stock analysis (pure) ────────────────────────────────────────────────
def split_sessions(df: pd.DataFrame) -> dict[str, pd.DataFrame]:
    t = df.index.time
    return {
        "pre": df[t < REGULAR_OPEN],
        "regular": df[(t >= REGULAR_OPEN) & (t < REGULAR_CLOSE)],
        "post": df[t >= REGULAR_CLOSE],
    }


def is_reverse_split(factor: Optional[str]) -> bool:
    """Yahoo reports '1:35' for a 1-for-35 reverse split."""
    try:
        new, old = (float(x) for x in str(factor).split(":"))
        return 0 < new < old
    except (TypeError, ValueError):
        return False


def spike_history(daily: Optional[pd.DataFrame]) -> int:
    """How many times in the last 6 months it spiked ≥50% intraday and closed well off the high."""
    if daily is None or len(daily) < 3:
        return 0
    d = daily.tail(130)
    prev = d["close"].shift(1)
    spiked = (d["high"] / prev >= 1.5) & (d["close"] < d["high"] * 0.75)
    return int(spiked.iloc[:-1].sum())   # exclude today


def analyze(
    symbol: str,
    df: Optional[pd.DataFrame],
    info: dict,
    fresh_news: list[dict],
    daily: Optional[pd.DataFrame],
    now: Optional[datetime] = None,
) -> Optional[dict]:
    if df is None or df.empty:
        return None
    now_utc = now or datetime.now(timezone.utc)
    s = split_sessions(df)
    reg, pre, post = s["regular"], s["pre"], s["post"]

    if reg.empty:
        # Only pre-market bars so far today → morning gapper mode
        mode = "premarket"
        state = info.get("marketState", "")
        prev_close = info.get("regularMarketPrice") if state in ("PRE", "PREPRE") else info.get("regularMarketPreviousClose")
        if not prev_close or pre.empty:
            return None
        price = float(pre["close"].iloc[-1])
        ext_move = (price / prev_close - 1) * 100
        ext_volume = float(pre["volume"].sum())
        ext_high = float(pre["high"].max())
        day_change, close_strength, reg_close, day_high, day_range_pct = None, None, None, None, None
        volume = ext_volume
    else:
        mode = "after_hours" if not post.empty else "day"
        prev_close = info.get("regularMarketPreviousClose") or info.get("previousClose")
        if not prev_close:
            return None
        reg_close = float(reg["close"].iloc[-1])
        day_high, day_low = float(reg["high"].max()), float(reg["low"].min())
        day_change = (reg_close / prev_close - 1) * 100
        rng = day_high - day_low
        close_strength = (reg_close - day_low) / rng if rng > 0 else 1.0
        day_range_pct = rng / reg_close * 100 if reg_close else None
        price = float(post["close"].iloc[-1]) if not post.empty else reg_close
        ext_move = (price / reg_close - 1) * 100 if not post.empty else 0.0
        ext_volume = float(post["volume"].sum())
        ext_high = float(post["high"].max()) if not post.empty else None
        volume = float(df["volume"].sum())

    avg_vol = info.get("averageDailyVolume3Month") or info.get("averageVolume")
    rel_volume = volume / avg_vol if avg_vol else None
    float_shares = info.get("floatShares")
    country = info.get("country")
    dma200 = info.get("twoHundredDayAverage")

    # What kind of candidate is it?
    if mode == "premarket":
        kind, move = "premarket_gap", ext_move
    elif ext_move >= 5:
        kind, move = "after_hours", ext_move
    else:
        kind, move = "day_runner", day_change or 0.0

    checks: list[dict] = []

    def check(key: str, status: str, label: str, core: bool = False):
        checks.append({"key": key, "status": status, "label": label, "core": core})

    move_label = {"premarket_gap": "Pre-market gap", "after_hours": "After-hours move", "day_runner": "Day gain"}[kind]
    check("move", "pass" if move >= MIN_CHANGE_PCT else "fail", f"{move_label} +{move:.0f}% (≥ {MIN_CHANGE_PCT:.0f}%)", True)
    check("float", "pass" if float_shares and float_shares < MAX_FLOAT else ("warn" if not float_shares else "fail"),
          f"Float {_fmt_shares(float_shares)} (< 20M)", True)
    check("price", "pass" if MIN_PRICE <= price <= MAX_PRICE else "fail", f"Price ${_round_px(price)} ($2–$20)", True)
    check("news", "pass" if fresh_news else "fail", "Fresh catalyst" if fresh_news else "No fresh news", True)
    check("rel_volume", "pass" if rel_volume and rel_volume >= MIN_REL_VOLUME else "fail",
          f"Relative volume {rel_volume:.1f}x (≥ 5x)" if rel_volume else "Relative volume unknown", True)

    if kind != "day_runner":
        check("ext_liquidity", "pass" if ext_volume >= MIN_EXT_VOLUME else "warn",
              f"{_fmt_shares(ext_volume)} shares traded {'pre-market' if mode == 'premarket' else 'after hours'}"
              + ("" if ext_volume >= MIN_EXT_VOLUME else " — thin, the move may not hold"))
    else:
        check("continuation", "warn", "Day-one runner — continuation plays only work in a hot market")
    if close_strength is not None:
        if close_strength >= 0.66:
            check("close", "pass", "Holding near the high of day")
        else:
            check("close", "warn", "Well off the high of day — don't get married to it")
    if day_range_pct is not None and day_change is not None and day_change >= 15 and day_range_pct < 1.5:
        check("buyout", "fail", "Jumped then traded flat all day — looks like a buyout, cross it off")
    if country in PUMP_RISK_COUNTRIES and not fresh_news:
        check("pump", "warn", f"{country} small cap with no news — pump-group risk, be skeptical")
    if dma200 and price < dma200 <= price * 1.15:
        check("dma200", "warn", f"200-day MA overhead at ${_round_px(dma200)}")
    split_date = info.get("lastSplitDate")
    if split_date and is_reverse_split(info.get("lastSplitFactor")):
        age = (now_utc - datetime.fromtimestamp(split_date, timezone.utc)).days
        if 0 <= age <= REVERSE_SPLIT_DAYS:
            check("reverse_split", "pass", f"Recent {info['lastSplitFactor']} reverse split ({age}d ago) — small float, a theme that has worked")
    first_trade = info.get("firstTradeDateMilliseconds")
    if first_trade:
        age = (now_utc - datetime.fromtimestamp(first_trade / 1000, timezone.utc)).days
        if 0 <= age <= RECENT_IPO_DAYS:
            check("ipo", "pass", f"Recent IPO ({age}d ago) — fresh supply/demand")
    spikes = spike_history(daily)
    if spikes >= 2:
        check("history", "warn", f"Spiked and faded {spikes}× in 6 months — expect sellers into strength")

    core_pass = sum(1 for c in checks if c["core"] and c["status"] == "pass")
    failed = [c for c in checks if not c["core"] and c["status"] == "fail"]
    if failed:
        tier, verdict = "skip", failed[0]["label"]
    elif core_pass == 5:
        tier, verdict = "A", "Top of tomorrow's list"
    elif core_pass == 4:
        tier, verdict = "B", "On the list — needs confirmation in pre-market"
    else:
        tier, verdict = "C", f"Low conviction — {core_pass}/5 pillars"

    key_level = ext_high if ext_high else day_high
    levels = {
        "prev_close": _round_px(prev_close),
        "regular_close": _round_px(reg_close),
        "day_high": _round_px(day_high),
        "ext_high": _round_px(ext_high),
        "dma200": _round_px(dma200),
        "key_level": _round_px(key_level),
    }
    if mode == "premarket":
        plan = (f"Pre-market high ${_round_px(ext_high)} is the level. Wait for the first pullback that holds VWAP, "
                f"buy the first candle making a new high. Don't chase the 9:30 open.")
    elif kind == "after_hours":
        plan = (f"Check it at 7 AM. If it holds above ${_round_px(reg_close)} in pre-market with volume, "
                f"a break of the after-hours high ${_round_px(ext_high)} is the momentum trigger — enter on the first pullback.")
    else:
        plan = (f"Only if it gaps up on fresh news tomorrow. Today's high ${_round_px(day_high)} is resistance; "
                f"it needs to reclaim it on volume before it's a trade.")

    return {
        "symbol": symbol,
        "name": info.get("shortName") or info.get("longName") or symbol,
        "exchange": info.get("exchange"),
        "sector": info.get("sector"),
        "country": country,
        "kind": kind,
        "price": _round_px(price),
        "move_pct": round(move, 2),
        "day_change_pct": round(day_change, 2) if day_change is not None else None,
        "ext_change_pct": round(ext_move, 2),
        "ext_volume": int(ext_volume),
        "volume": int(volume),
        "rel_volume": round(rel_volume, 1) if rel_volume else None,
        "float_shares": int(float_shares) if float_shares else None,
        "close_strength": round(close_strength, 2) if close_strength is not None else None,
        "news": fresh_news[:3],
        "has_fresh_news": bool(fresh_news),
        "checks": checks,
        "core_score": core_pass,
        "tier": tier,
        "verdict": verdict,
        "levels": levels,
        "plan": plan,
    }


def _fmt_shares(n: Optional[float]) -> str:
    if not n:
        return "n/a"
    if n >= 1e6:
        return f"{n / 1e6:.1f}M"
    if n >= 1e3:
        return f"{n / 1e3:.0f}K"
    return str(int(n))


# ── data ─────────────────────────────────────────────────────────────────────
def _daily_bars(symbols: list[str]) -> dict[str, pd.DataFrame]:
    if not symbols:
        return {}
    try:
        raw = yf.download(symbols, period="1y", interval="1d", progress=False, group_by="ticker", auto_adjust=False, threads=True)
    except Exception as e:
        logger.warning("Daily download failed: %s", e)
        return {}
    out = {}
    for s in symbols:
        try:
            df = raw[s] if isinstance(raw.columns, pd.MultiIndex) else raw
            out[s] = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]].dropna(subset=["close"])
        except Exception:
            continue
    return out


def get_daily_bars(symbol: str) -> list[dict]:
    """1 year of daily candles with the 20 and 200-day moving averages."""
    def _fetch() -> list[dict]:
        df = _daily_bars([symbol]).get(symbol)
        if df is None or df.empty:
            return []
        sma20 = df["close"].rolling(20).mean()
        sma200 = df["close"].rolling(200).mean()
        return [
            {
                "time": int(pd.Timestamp(ts).tz_localize(None).timestamp()) if pd.Timestamp(ts).tzinfo is None
                else int(pd.Timestamp(ts).tz_convert("UTC").normalize().timestamp()),
                "open": float(r.open), "high": float(r.high), "low": float(r.low), "close": float(r.close),
                "volume": float(r.volume),
                "sma20": float(a) if pd.notna(a) else None,
                "sma200": float(b) if pd.notna(b) else None,
            }
            for (ts, r), a, b in zip(df.iterrows(), sma20, sma200)
        ]
    return _cached(f"daily:{symbol}", 600, _fetch)


_TIER_ORDER = {"A": 0, "B": 1, "C": 2, "skip": 3}


def build_watchlist(extra: Optional[list[str]] = None, limit: int = 30) -> dict:
    extra = [e.upper() for e in (extra or []) if e]

    def _run() -> dict:
        from concurrent.futures import ThreadPoolExecutor

        phase = watchlist_phase()
        session = "preMarket" if phase["key"] == "premarket" else "afterHours" if phase["key"] != "regular" else "currentMarket"
        universe = list(dict.fromkeys(
            extra + nasdaq_gainers(session)[:25] + _screen_universe()[:30] + _alpaca_gainers()[:10]
        ))[:60]

        bars = _today_bars(universe)
        with ThreadPoolExecutor(max_workers=8) as ex:
            infos = dict(zip(universe, ex.map(_info, universe)))
            news = dict(zip(universe, ex.map(_news, universe)))
        cutoff = _catalyst_cutoff()

        def fresh(sym: str) -> list[dict]:
            out = []
            for n in news.get(sym, []):
                try:
                    if datetime.fromisoformat(n["published"].replace("Z", "+00:00")) >= cutoff:
                        out.append(n)
                except ValueError:
                    pass
            return out

        # Daily history only for names worth a deeper look (spike/fade check)
        prelim = [s for s in universe if bars.get(s) is not None]
        daily = _daily_bars(prelim[:40])

        rows = []
        for sym in prelim:
            info = infos.get(sym) or {}
            if info.get("quoteType") not in (None, "EQUITY"):
                continue
            try:
                r = analyze(sym, bars.get(sym), info, fresh(sym), daily.get(sym))
            except Exception as e:
                logger.debug("watchlist analyze failed for %s: %s", sym, e)
                continue
            if r and (r["move_pct"] >= 5 or sym in extra):
                r["pinned"] = sym in extra
                rows.append(r)

        rows.sort(key=lambda r: (_TIER_ORDER[r["tier"]], -r["move_pct"]))
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "phase": phase,
            "notes": session_notes(phase),
            "candidates": rows[:limit],
        }

    return _cached(f"watchlist:{','.join(sorted(extra))}:{limit}", 60, _run)
