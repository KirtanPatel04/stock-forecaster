"""Ross Cameron (Warrior Trading) small-cap momentum scanner.

Implements the stock-selection and entry rules from the
`.claude/skills/ross-cameron-day-trading` skill:

  Five Pillars   — up ≥10%, ≥5x relative volume, fresh news, $2–$20, float <20M
  A-quality      — up ≥30%, $5–$10, float <10M, 7–10 AM ET
  Entry          — first pullback (≤50% retrace, light red volume, holds VWAP / 9 EMA),
                   buy the first candle to make a new high, stop at the pullback low,
                   target a retest of the high of day.

US small caps only (Ross trades US-listed stocks), so this uses Yahoo's live
screener + 1-minute bars (which include pre-market) rather than the TSX universe
the rest of the app uses. Position sizing depends on the user's cash and
session state, so it lives in the frontend (`src/lib/rossRules.ts`).
"""
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import yfinance as yf
from yfinance import EquityQuery

logger = logging.getLogger(__name__)

ET = ZoneInfo("America/New_York")

# ── Five Pillars thresholds (keep in sync with SKILL.md) ─────────────────────
MIN_CHANGE_PCT = 10.0
MIN_REL_VOLUME = 5.0
MIN_PRICE, MAX_PRICE = 2.0, 20.0
MAX_FLOAT = 20_000_000

# A-quality extras
A_MIN_CHANGE_PCT = 30.0
A_MIN_PRICE, A_MAX_PRICE = 5.0, 10.0
A_MAX_FLOAT = 10_000_000
BIG_VOLUME = 25_000_000

# Entry pattern
MAX_RETRACE = 0.50
SQUEEZE_LOOKBACK_BARS = 60   # the "move" is measured from the lowest low in the hour before HOD
STALE_BARS = 30              # no new high in 30 min → momentum fading

# Fast-trade targets: a day trade should reach 2:1 within ~30 minutes, judged by how this stock has actually moved today
HOLD_MINUTES = 30
PROFILE_LOOKBACK_BARS = 120  # measure behaviour over the last ~2 hours
NOISE_FRACTION = 0.5         # a stop tighter than ½ an average 1-min candle just gets hit by noise

# Screener is deliberately a little wider than the pillars so 4/5 candidates show up too
SCREEN_MIN_CHANGE = 5.0
SCREEN_MIN_PRICE, SCREEN_MAX_PRICE = 1.0, 25.0
SCREEN_MIN_VOLUME = 50_000

US_EXCHANGES = {"NMS", "NCM", "NGM", "NAS", "NYQ", "ASE", "PCX", "BTS"}
HALT_PRONE_EXCHANGES = {"NYQ", "ASE"}


# ── tiny TTL cache ───────────────────────────────────────────────────────────
_cache: dict[str, tuple[float, Any]] = {}
_cache_lock = threading.Lock()


def _cached(key: str, ttl: float, fn: Callable[[], Any]) -> Any:
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = fn()
    with _cache_lock:
        _cache[key] = (now, value)
    return value


def _round_px(p: Optional[float]) -> Optional[float]:
    if p is None or not np.isfinite(p):
        return None
    return round(float(p), 4 if p < 1 else 2)


def _is_derivative(symbol: str) -> bool:
    # Warrants (…W, …WS), units (…U) and rights (…R) aren't ordinary shares
    return "." in symbol or "-" in symbol or (len(symbol) >= 5 and symbol[-1] in ("W", "U", "R"))


# ── time window ──────────────────────────────────────────────────────────────
def trading_window(now: Optional[datetime] = None) -> dict:
    """Where we are relative to Ross's 7–10 AM ET edge."""
    now_et = (now or datetime.now(timezone.utc)).astimezone(ET)
    mins = now_et.hour * 60 + now_et.minute
    if now_et.weekday() >= 5:
        key, label = "closed", "Weekend — build Monday's watchlist"
    elif mins < 7 * 60:
        key, label = "early", "Pre-market warming up — prime window opens 7:00 AM ET"
    elif mins < 9 * 60 + 30:
        key, label = "prime", "Prime window (pre-market) — cleanest action"
    elif mins < 10 * 60:
        key, label = "prime", "Prime window (open) — watch for halts & stop runs"
    elif mins < 11 * 60 + 30:
        key, label = "late", "Past 10 AM — edge declining, A+ setups only"
    elif mins < 16 * 60:
        key, label = "off", "Outside his window — consider walking away"
    else:
        key, label = "closed", "After hours — note tomorrow's gappers"
    return {"key": key, "label": label, "et_time": now_et.strftime("%-I:%M %p ET")}


# ── pillars ──────────────────────────────────────────────────────────────────
def evaluate_pillars(
    change_pct: Optional[float],
    rel_volume: Optional[float],
    has_news: Optional[bool],
    price: Optional[float],
    float_shares: Optional[float],
    volume: Optional[float] = None,
    in_prime_window: bool = False,
) -> dict:
    """Score a stock against the Five Pillars. `None` inputs are 'unknown' (not passed)."""

    def check(ok: Optional[bool], value: Any, rule: str) -> dict:
        return {"pass": ok, "value": value, "rule": rule}

    pillars = {
        "change": check(None if change_pct is None else change_pct >= MIN_CHANGE_PCT,
                        change_pct, f"Up ≥ {MIN_CHANGE_PCT:.0f}% on the day"),
        "rel_volume": check(None if rel_volume is None else rel_volume >= MIN_REL_VOLUME,
                            rel_volume, f"≥ {MIN_REL_VOLUME:.0f}x relative volume"),
        "news": check(has_news, has_news, "Fresh news catalyst"),
        "price": check(None if price is None else MIN_PRICE <= price <= MAX_PRICE,
                       price, f"Price ${MIN_PRICE:.0f}–${MAX_PRICE:.0f}"),
        "float": check(None if float_shares is None else float_shares < MAX_FLOAT,
                       float_shares, f"Float < {MAX_FLOAT // 1_000_000}M shares"),
    }
    score = sum(1 for p in pillars.values() if p["pass"])

    a_plus_checks = {
        "change_30": change_pct is not None and change_pct >= A_MIN_CHANGE_PCT,
        "price_5_10": price is not None and A_MIN_PRICE <= price <= A_MAX_PRICE,
        "float_10m": float_shares is not None and float_shares < A_MAX_FLOAT,
        "prime_window": in_prime_window,
    }
    if score == 5 and all(a_plus_checks.values()):
        grade = "A+"
    elif score == 5:
        grade = "A"
    elif score == 4:
        grade = "B"
    else:
        grade = "C"

    return {
        "pillars": pillars,
        "score": score,
        "grade": grade,
        "a_plus": a_plus_checks,
        "big_volume": volume is not None and volume >= BIG_VOLUME,
    }


def market_temperature(candidates: list[dict]) -> dict:
    """Hot / warm / cold — how many real runners (≥5x RVOL) are on the board today."""
    runners = [c for c in candidates if (c.get("rel_volume") or 0) >= MIN_REL_VOLUME]
    big = sum(1 for c in runners if (c.get("change_pct") or 0) >= 50)
    huge = sum(1 for c in runners if (c.get("change_pct") or 0) >= 100)
    mid = sum(1 for c in runners if (c.get("change_pct") or 0) >= A_MIN_CHANGE_PCT)
    if big >= 3 or huge >= 2:
        key, advice = "hot", "Hot market — momentum is paying. 4/5 pillars OK, but take your foot off the gas fast when it cools."
    elif mid >= 1:
        key, advice = "warm", "Warm — stick to the leading gainers that meet all 5 pillars."
    else:
        key, advice = "cold", "Cold market — 5/5 pillars only, use the smaller cold-market goal, walk away early."
    return {"key": key, "runners_50": big, "runners_100": huge, "runners_30": mid, "advice": advice}


# ── entry pattern (first pullback) ───────────────────────────────────────────
def analyze_setup(df: pd.DataFrame) -> dict:
    """Classify today's 1-minute bars against Ross's first-pullback pattern.

    States: extended (squeezing — don't chase), pullback (setup forming),
    triggered (first candle making a new high), broken (lost VWAP / >50% retrace),
    stale (no new high in 30+ min), none (no move / not enough data).
    """
    out: dict[str, Any] = {"state": "none", "summary": "Not enough intraday data yet.", "checks": {}}
    if df is None or len(df) < 5:
        return out

    o = df["open"].to_numpy(float)
    h = df["high"].to_numpy(float)
    lo = df["low"].to_numpy(float)
    c = df["close"].to_numpy(float)
    v = df["volume"].to_numpy(float)

    tp = (h + lo + c) / 3
    cum_v = np.cumsum(v)
    vwap = np.where(cum_v > 0, np.cumsum(tp * v) / np.where(cum_v > 0, cum_v, 1), c)
    ema9 = pd.Series(c).ewm(span=9, adjust=False).mean().to_numpy()

    profile = move_profile(h, lo, c)

    hod_idx = int(np.flatnonzero(h == h.max())[-1])
    hod = float(h[hod_idx])
    start = max(0, hod_idx - SQUEEZE_LOOKBACK_BARS)
    base = float(lo[start:hod_idx + 1].min())
    move = hod - base
    last = float(c[-1])
    last_vwap, last_ema9 = float(vwap[-1]), float(ema9[-1])
    bars_since_hod = len(c) - 1 - hod_idx

    out.update({
        "hod": _round_px(hod),
        "squeeze_low": _round_px(base),
        "vwap": _round_px(last_vwap),
        "ema9": _round_px(last_ema9),
        "last": _round_px(last),
        "bars_since_hod": bars_since_hod,
        "atr_1m": _round_px(profile["atr_1m"]),
        "up30_median": _round_px(profile["up30_median"]),
        "up30_p75": _round_px(profile["up30_p75"]),
    })
    if move <= 0 or move / base < 0.02:
        out["summary"] = "No meaningful squeeze yet today."
        return out

    # Topping tail on the high-of-day candle (bearish)
    rng = h[hod_idx] - lo[hod_idx]
    upper_wick = h[hod_idx] - max(o[hod_idx], c[hod_idx])
    topping_tail = bool(rng > 0 and upper_wick >= 0.5 * rng)

    push = slice(start, hod_idx + 1)
    green_push = v[push][c[push] >= o[push]]
    green_vol = float(green_push.mean()) if len(green_push) else 0.0

    if bars_since_hod <= 1:
        out.update({
            "state": "extended",
            "summary": "Squeezing at the highs — don't chase. Wait for the first pullback.",
            "topping_tail": topping_tail,
        })
        return out

    after = slice(hod_idx + 1, len(c))
    pb_rel = int(np.argmin(lo[after]))
    pb_idx = hod_idx + 1 + pb_rel
    pullback_low = float(lo[pb_idx])
    retrace = (hod - pullback_low) / move
    red_after = v[after][c[after] < o[after]]
    red_vol = float(red_after.mean()) if len(red_after) else 0.0
    light_red = red_vol < green_vol if green_vol > 0 else True

    checks = {
        "retrace_ok": {"pass": retrace <= MAX_RETRACE, "label": f"Retrace {retrace * 100:.0f}% (≤ 50%)"},
        "light_red_volume": {"pass": light_red, "label": "Lighter volume on red candles"},
        "above_vwap": {"pass": last >= last_vwap, "label": f"Holding VWAP ${_round_px(last_vwap)}"},
        "above_ema9": {"pass": last >= last_ema9 * 0.995, "label": f"Holding 9 EMA ${_round_px(last_ema9)}"},
        "no_topping_tail": {"pass": not topping_tail, "label": "No topping tail at high of day"},
    }
    out.update({"checks": checks, "retrace_pct": round(retrace * 100, 1), "pullback_low": _round_px(pullback_low),
                "topping_tail": topping_tail})

    if retrace > MAX_RETRACE or last < last_vwap:
        why = "lost VWAP" if last < last_vwap else f"retraced {retrace * 100:.0f}% of the move"
        out.update({"state": "broken", "summary": f"Pattern broken — {why}. No trade until it rebuilds."})
        return out
    if bars_since_hod > STALE_BARS:
        out.update({"state": "stale", "summary": f"No new high in {bars_since_hod} min — momentum fading."})
        return out

    # Crossing candle: the latest candle broke the prior candle's high after the pullback low printed
    triggered = pb_idx < len(c) - 1 and h[-1] > h[-2]
    entry = max(last, float(h[-2]) + 0.01) if triggered else float(h[-1]) + 0.01
    stop = fast_stop(entry, pullback_low, profile)
    risk = entry - stop
    targets = realistic_targets(entry, stop, hod, move, profile)

    out.update({
        "state": "triggered" if triggered else "pullback",
        "summary": (
            "First candle making a new high — entry trigger is live."
            if triggered else
            f"Pulling back {retrace * 100:.0f}% — buy the first candle that breaks ${_round_px(float(h[-1]))}."
        ),
        "entry": _round_px(entry),
        "stop": _round_px(stop),
        "structural_stop": _round_px(pullback_low),
        "risk_per_share": _round_px(risk),
        "stop_in_noise": risk < NOISE_FRACTION * profile["atr_1m"] - 1e-9,
    })
    if targets:
        out.update({
            "target": targets["target"],
            "targets": targets["targets"],
            "reach_2r": targets["reach_2r"],
            "minutes_2r": targets["minutes_2r"],
            "hod_r": targets["hod_r"],
        })
        if targets["reach_2r"] == "stretch":
            out["summary"] += (f" A 2:1 target (${targets['target']}) is more than this stock usually moves in "
                               f"{HOLD_MINUTES} min — not a fast trade.")
    return out


def move_profile(h: np.ndarray, lo: np.ndarray, c: np.ndarray,
                 minutes: int = HOLD_MINUTES, lookback: int = PROFILE_LOOKBACK_BARS) -> dict:
    """How far this stock has actually run up within `minutes` of a bar, over the last ~2 hours.

    For every recent bar, the best high reached in the following `minutes` bars minus that bar's
    close. The median is a typical run, the 75th percentile a good one. Falls back to a
    random-walk estimate from the average 1-minute range when there isn't enough history.
    """
    n = len(c)
    atr = float(np.mean((h - lo)[-14:])) if n else 0.0
    ups = [
        max(0.0, float(h[i + 1:i + 1 + minutes].max()) - float(c[i]))
        for i in range(max(0, n - lookback - minutes), n - minutes)
    ]
    if len(ups) >= 10:
        median, p75 = float(np.median(ups)), float(np.percentile(ups, 75))
    else:
        median, p75 = atr * np.sqrt(minutes) * 0.6, atr * np.sqrt(minutes)
    return {"atr_1m": atr, "up30_median": median, "up30_p75": max(p75, median), "samples": len(ups)}


def _tick(price: float) -> float:
    return 0.0001 if price < 1 else 0.01


def fast_stop(entry: float, structural_stop: Optional[float], profile: dict) -> float:
    """Tightest sensible stop for a ≤30-minute trade.

    Risk = the tighter of (a) half a typical 30-minute run, so 2R fits inside it, and (b) the
    pullback low, Ross's structural stop — but never inside the noise floor (½ an average
    1-min candle, min one tick), where ordinary wiggles would stop you out.
    """
    tick = _tick(entry)
    noise = max(tick, NOISE_FRACTION * profile["atr_1m"])
    risk = profile["up30_median"] / 2
    if structural_stop is not None and structural_stop < entry:
        risk = min(risk, entry - structural_stop)
    risk = max(risk, noise)
    stop = np.floor((entry - risk) / tick + 1e-9) * tick   # round down to a valid price
    return round(float(min(stop, entry - tick)), 4)


def estimate_minutes(distance: float, profile: dict, minutes: int = HOLD_MINUTES) -> Optional[int]:
    """Rough time to travel `distance`, scaling the typical 30-min run by √time."""
    med = profile["up30_median"]
    if med <= 0:
        return None
    return max(1, int(round(minutes * (distance / med) ** 2)))


def realistic_targets(entry: float, stop: float, hod: float, move: float, profile: dict) -> Optional[dict]:
    """Targets in R (risk multiples), each rated by how realistic it is within ~30 minutes.

    Time: 'likely' if a typical 30-min run (median) covers it, 'possible' if a good run (75th pct)
    does, else 'stretch'. Structure: a target above the high of day needs a breakout, so it can be
    at best 'possible', and a 'stretch' if it's beyond half the first squeeze leg past the high.
    The worse of the two wins. Keep in sync with `realisticTargets` in frontend/src/lib/rossRules.ts.
    """
    risk = entry - stop
    if risk <= 0:
        return None
    order = {"likely": 0, "possible": 1, "stretch": 2}

    def reach(price: float) -> str:
        d = price - entry - 1e-9
        by_time = "likely" if d <= profile["up30_median"] else "possible" if d <= profile["up30_p75"] else "stretch"
        by_structure = "likely" if price <= max(hod, entry) else "possible" if price <= hod + 0.5 * move else "stretch"
        return max(by_time, by_structure, key=order.get)

    def target(label: str, price: float) -> dict:
        return {"label": label, "price": _round_px(price), "r": round((price - entry) / risk, 2),
                "reach": reach(price), "minutes": estimate_minutes(price - entry, profile)}

    targets = [target("2:1 target", entry + 2 * risk), target("3:1 runner", entry + 3 * risk)]
    if hod > entry:
        targets.append(target("HOD retest", hod))
    targets.sort(key=lambda t: t["price"])

    two = targets[[t["label"] for t in targets].index("2:1 target")]
    return {
        "target": two["price"],
        "targets": targets,
        "reach_2r": two["reach"],
        "minutes_2r": two["minutes"],
        "hod_r": round((hod - entry) / risk, 2) if hod > entry else 0.0,
    }


# ── data fetching ────────────────────────────────────────────────────────────
def _screen_universe(size: int = 60) -> list[str]:
    def _fetch() -> list[str]:
        q = EquityQuery("and", [
            EquityQuery("gt", ["percentchange", SCREEN_MIN_CHANGE]),
            EquityQuery("btwn", ["intradayprice", SCREEN_MIN_PRICE, SCREEN_MAX_PRICE]),
            EquityQuery("eq", ["region", "us"]),
            EquityQuery("gt", ["dayvolume", SCREEN_MIN_VOLUME]),
        ])
        try:
            res = yf.screen(q, sortField="percentchange", sortAsc=False, size=size)
            quotes = res.get("quotes", [])
        except Exception as e:
            logger.warning("Yahoo small-cap screen failed: %s", e)
            quotes = []
        return [
            q["symbol"] for q in quotes
            if q.get("quoteType", "EQUITY") == "EQUITY"
            and q.get("exchange") in US_EXCHANGES
            and not _is_derivative(q["symbol"])
        ]
    return _cached("screen_universe", 45, _fetch)


def _alpaca_gainers() -> list[str]:
    """Alpaca's movers list catches pre-market gappers Yahoo's screener sorts late."""
    try:
        from ..data.alpaca_client import get_market_movers_detail
        detail = get_market_movers_detail(top=30)
        return [
            m["symbol"] for m in detail["gainers"]
            if SCREEN_MIN_PRICE <= m["price"] <= SCREEN_MAX_PRICE and not _is_derivative(m["symbol"])
        ]
    except Exception as e:
        logger.debug("Alpaca movers unavailable: %s", e)
        return []


NASDAQ_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    "Accept": "application/json",
}


def nasdaq_gainers(session: str = "currentMarket") -> list[str]:
    """Nasdaq.com's 'most advanced' list (all US listings). `session` is currentMarket,
    preMarket or afterHours — the only free source here that ranks extended-hours movers."""
    def _fetch() -> list[str]:
        try:
            import httpx
            r = httpx.get(
                "https://api.nasdaq.com/api/marketmovers",
                params={"assetclass": "stocks", "exchangestatus": session, "limit": 50},
                headers=NASDAQ_HEADERS, timeout=10,
            )
            rows = (((r.json().get("data") or {}).get("STOCKS") or {}).get("MostAdvanced") or {}).get("table", {}).get("rows") or []
        except Exception as e:
            logger.debug("Nasdaq movers (%s) failed: %s", session, e)
            return []
        out = []
        for row in rows:
            sym = (row.get("symbol") or "").strip().upper()
            try:
                price = float(str(row.get("lastSalePrice", "")).replace("$", "").replace(",", ""))
            except ValueError:
                continue
            if sym and not _is_derivative(sym) and SCREEN_MIN_PRICE <= price <= SCREEN_MAX_PRICE:
                out.append(sym)
        return out
    return _cached(f"nasdaq:{session}", 60, _fetch)


def market_session(now: Optional[datetime] = None) -> str:
    """Nasdaq-style session name for right now."""
    now_et = (now or datetime.now(timezone.utc)).astimezone(ET)
    mins = now_et.hour * 60 + now_et.minute
    if now_et.weekday() < 5 and 4 * 60 <= mins < 9 * 60 + 30:
        return "preMarket"
    if now_et.weekday() < 5 and 9 * 60 + 30 <= mins < 16 * 60:
        return "currentMarket"
    return "afterHours"


def _info(symbol: str) -> dict:
    def _fetch() -> dict:
        try:
            return yf.Ticker(symbol).info or {}
        except Exception as e:
            logger.debug("info failed for %s: %s", symbol, e)
            return {}
    return _cached(f"info:{symbol}", 60, _fetch)


def _catalyst_cutoff(now: Optional[datetime] = None) -> datetime:
    """News counts as 'fresh' if it dropped since the prior session's close (weekend-aware)."""
    now_et = (now or datetime.now(timezone.utc)).astimezone(ET)
    days_back = {0: 3, 6: 2, 5: 1}.get(now_et.weekday(), 1)
    prev = (now_et - timedelta(days=days_back)).replace(hour=16, minute=0, second=0, microsecond=0)
    return prev.astimezone(timezone.utc)


def _news(symbol: str) -> list[dict]:
    def _fetch() -> list[dict]:
        try:
            raw = yf.Ticker(symbol).news or []
        except Exception as e:
            logger.debug("news failed for %s: %s", symbol, e)
            return []
        items = []
        for n in raw[:10]:
            content = n.get("content") or n
            title = content.get("title")
            pub = content.get("pubDate") or content.get("displayTime")
            if not pub and n.get("providerPublishTime"):
                pub = datetime.fromtimestamp(n["providerPublishTime"], timezone.utc).isoformat()
            if not title or not pub:
                continue
            url = (content.get("canonicalUrl") or {}).get("url") or (content.get("clickThroughUrl") or {}).get("url") or n.get("link")
            publisher = (content.get("provider") or {}).get("displayName") or n.get("publisher")
            items.append({"title": title, "published": pub, "url": url, "publisher": publisher})
        return items
    return _cached(f"news:{symbol}", 300, _fetch)


def _today_bars(symbols: list[str]) -> dict[str, pd.DataFrame]:
    """1-minute bars for the latest session, including pre-market, in ET."""
    if not symbols:
        return {}
    try:
        raw = yf.download(symbols, period="1d", interval="1m", prepost=True,
                          progress=False, group_by="ticker", threads=True, auto_adjust=False)
    except Exception as e:
        logger.warning("Intraday download failed: %s", e)
        return {}
    out = {}
    for s in symbols:
        try:
            df = raw[s] if isinstance(raw.columns, pd.MultiIndex) else raw
            df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]].dropna(subset=["close"])
            if df.empty:
                continue
            df.index = pd.to_datetime(df.index).tz_convert(ET)
            last_day = df.index[-1].date()
            out[s] = df[df.index.date == last_day]
        except Exception:
            continue
    return out


def live_setups(symbols: list[str]) -> dict[str, dict]:
    """Latest price + first-pullback setup for many symbols in one Yahoo request (cached 5s),
    so every scanner row's entry / stop / 2:1 target and share size can move with the price."""
    symbols = sorted({s.upper() for s in symbols if s})[:40]
    if not symbols:
        return {}

    def _fetch() -> dict[str, dict]:
        out = {}
        for sym, df in _today_bars(symbols).items():
            if df is None or df.empty:
                continue
            out[sym] = {
                "price": _round_px(float(df["close"].iloc[-1])),
                "time": int(df.index[-1].timestamp()),
                "setup": analyze_setup(df),
            }
        return out

    return _cached(f"live:{','.join(symbols)}", 5, _fetch)


def get_intraday_bars(symbol: str) -> list[dict]:
    """1-minute bars with VWAP and 9 EMA for the Day Trade chart."""
    def _fetch() -> list[dict]:
        df = _today_bars([symbol]).get(symbol)
        if df is None or df.empty:
            return []
        tp = (df["high"] + df["low"] + df["close"]) / 3
        cum_v = df["volume"].cumsum()
        vwap = (tp * df["volume"]).cumsum() / cum_v.where(cum_v > 0)
        ema9 = df["close"].ewm(span=9, adjust=False).mean()
        return [
            {
                "time": int(ts.timestamp()),
                "open": float(r.open), "high": float(r.high), "low": float(r.low), "close": float(r.close),
                "volume": float(r.volume),
                "vwap": float(vw) if pd.notna(vw) else float(r.close),
                "ema9": float(e),
            }
            for (ts, r), vw, e in zip(df.iterrows(), vwap, ema9)
        ]
    return _cached(f"bars:{symbol}", 5, _fetch)


# ── evaluation ───────────────────────────────────────────────────────────────
def _evaluate(symbols: list[str], window: dict) -> list[dict]:
    bars = _today_bars(symbols)
    with ThreadPoolExecutor(max_workers=8) as ex:
        infos = dict(zip(symbols, ex.map(_info, symbols)))
        news = dict(zip(symbols, ex.map(_news, symbols)))

    cutoff = _catalyst_cutoff()
    in_prime = window["key"] == "prime"
    results = []
    for s in symbols:
        info = infos.get(s) or {}
        if info.get("quoteType") not in (None, "EQUITY"):
            continue
        exchange = info.get("exchange")
        if exchange and exchange not in US_EXCHANGES:
            continue
        df = bars.get(s)

        state = info.get("marketState", "")
        if state in ("PRE", "PREPRE"):
            prev_close = info.get("regularMarketPrice")        # yesterday's close
        else:
            prev_close = info.get("regularMarketPreviousClose") or info.get("previousClose")
        price = float(df["close"].iloc[-1]) if df is not None and len(df) else info.get("regularMarketPrice")
        if not price or not prev_close:
            continue
        change_pct = (price / prev_close - 1) * 100

        volume = float(df["volume"].sum()) if df is not None and len(df) else info.get("regularMarketVolume")
        avg_vol = info.get("averageDailyVolume3Month") or info.get("averageVolume")
        rel_volume = volume / avg_vol if volume and avg_vol else None

        fresh = []
        for n in news.get(s, []):
            try:
                if datetime.fromisoformat(n["published"].replace("Z", "+00:00")) >= cutoff:
                    fresh.append(n)
            except ValueError:
                continue

        float_shares = info.get("floatShares")
        ev = evaluate_pillars(change_pct, rel_volume, bool(fresh), price, float_shares, volume, in_prime)
        setup = analyze_setup(df) if df is not None else analyze_setup(None)

        flags = []
        if not fresh:
            flags.append("No fresh catalyst — could be a short squeeze; trade with less risk")
        if exchange in HALT_PRONE_EXCHANGES:
            flags.append("NYSE/AMEX listing — more prone to volatility halts after the open")
        spf = info.get("shortPercentOfFloat")
        if spf and spf >= 0.15:
            flags.append(f"Short interest {spf * 100:.0f}% of float — squeeze fuel")
        dma200 = info.get("twoHundredDayAverage")
        if dma200 and price < dma200 <= price * 1.15:
            flags.append(f"200-day MA overhead at ${_round_px(dma200)} — possible resistance")
        if price < MIN_PRICE:
            flags.append("Under $2 — below his price range")
        if ev["big_volume"]:
            flags.append("25M+ shares traded — heavy participation")

        results.append({
            "symbol": s,
            "name": info.get("shortName") or info.get("longName") or s,
            "exchange": exchange,
            "sector": info.get("sector"),
            "country": info.get("country"),
            "price": _round_px(price),
            "prev_close": _round_px(prev_close),
            "change_pct": round(change_pct, 2),
            "volume": int(volume) if volume else None,
            "avg_volume": int(avg_vol) if avg_vol else None,
            "rel_volume": round(rel_volume, 1) if rel_volume else None,
            "float_shares": int(float_shares) if float_shares else None,
            "short_pct_float": round(spf * 100, 1) if spf else None,
            "day_high": _round_px(float(df["high"].max())) if df is not None and len(df) else _round_px(info.get("dayHigh")),
            "market_state": state,
            "news": fresh[:3] or news.get(s, [])[:1],
            "has_fresh_news": bool(fresh),
            **ev,
            "setup": setup,
            "flags": flags,
        })
    return results


_GRADE_ORDER = {"A+": 0, "A": 1, "B": 2, "C": 3}


def scan(limit: int = 25) -> dict:
    """Live Five-Pillars scan of US small-cap gainers, most obvious first."""
    def _run() -> dict:
        window = trading_window()
        universe = list(dict.fromkeys(
            nasdaq_gainers(market_session())[:20] + _screen_universe()[:40] + _alpaca_gainers()[:15]
        ))
        candidates = [c for c in _evaluate(universe, window) if c["change_pct"] >= SCREEN_MIN_CHANGE]

        # Obviousness = rank among today's leading gainers
        for i, c in enumerate(sorted(candidates, key=lambda c: -c["change_pct"])):
            c["gainer_rank"] = i + 1
        candidates.sort(key=lambda c: (_GRADE_ORDER[c["grade"]], -c["change_pct"]))

        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "window": window,
            "temperature": market_temperature(candidates),
            "candidates": candidates[:limit],
        }
    return _cached(f"scan:{limit}", 45, _run)


def evaluate_symbol(symbol: str) -> Optional[dict]:
    symbol = symbol.upper().strip()
    res = _evaluate([symbol], trading_window())
    return res[0] if res else None


def market_overview() -> dict:
    """Webull-style market rail: index ETFs + top gainers / losers / most active."""
    def _run() -> dict:
        indices = []
        idx = {"SPY": "S&P 500", "QQQ": "Nasdaq 100", "IWM": "Russell 2000", "DIA": "Dow 30"}
        try:
            raw = yf.download(list(idx), period="5d", interval="1d", progress=False, group_by="ticker", auto_adjust=False)
            for sym, label in idx.items():
                d = raw[sym].rename(columns=str.lower).dropna(subset=["close"])
                if len(d) >= 2:
                    last, prev = float(d["close"].iloc[-1]), float(d["close"].iloc[-2])
                    indices.append({"symbol": sym, "label": label, "price": round(last, 2),
                                    "change_pct": round((last / prev - 1) * 100, 2)})
        except Exception as e:
            logger.warning("Index quotes failed: %s", e)

        def _list(screen: str) -> list[dict]:
            try:
                quotes = yf.screen(screen, count=25).get("quotes", [])
            except Exception as e:
                logger.warning("Yahoo screen %s failed: %s", screen, e)
                return []
            return [
                {
                    "symbol": q["symbol"],
                    "name": q.get("shortName") or q["symbol"],
                    "price": _round_px(q.get("regularMarketPrice")),
                    "change_pct": round(q.get("regularMarketChangePercent") or 0, 2),
                    "volume": q.get("regularMarketVolume"),
                }
                for q in quotes if q.get("regularMarketPrice") and not _is_derivative(q["symbol"])
            ][:15]

        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "indices": indices,
            "gainers": _list("day_gainers"),
            "losers": _list("day_losers"),
            "actives": _list("most_actives"),
            "small_caps": _list("small_cap_gainers"),
        }
    return _cached("market_overview", 60, _run)
