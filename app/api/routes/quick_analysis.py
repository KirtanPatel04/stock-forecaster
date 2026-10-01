"""Intraday analysis with real technical indicators — RSI, MACD, VWAP, Bollinger Bands,
EMA crossovers, support/resistance, and a VWAP-anchored forecast model."""
import logging
from datetime import datetime, timedelta, timezone
from math import sqrt
from typing import Optional

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ...database import get_db
from ...data.market_router import get_latest_price
from ...data.data_manager import fetch_and_cache_bars, get_cached_bars, get_cached_news

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/quick", tags=["quick"])

FORECAST_HORIZONS = [15, 30, 60, 120, 240, 390]


# ── Technical indicator helpers ─────────────────────────────────────────────

def _rsi(closes: np.ndarray, period: int = 14) -> float:
    if len(closes) < period + 1:
        return 50.0
    deltas = np.diff(closes.astype(float))
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    avg_gain = float(np.mean(gains[-period:]))
    avg_loss = float(np.mean(losses[-period:]))
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 1)


def _ema(values: np.ndarray, period: int) -> float:
    """Exponential moving average — last value."""
    arr = values.astype(float)
    if len(arr) < period:
        return float(arr[-1])
    k = 2.0 / (period + 1)
    ema = float(np.mean(arr[:period]))
    for v in arr[period:]:
        ema = v * k + ema * (1 - k)
    return ema


def _macd(closes: np.ndarray):
    """Returns (macd_line, signal_line, histogram, direction)."""
    if len(closes) < 35:
        return 0.0, 0.0, 0.0, "neutral"
    arr = closes.astype(float)
    ema12 = _ema(arr, 12)
    ema26 = _ema(arr, 26)
    macd_line = ema12 - ema26

    # Build last 9 MACD values for signal line
    macd_hist = []
    for i in range(9, 0, -1):
        sub = arr[:-i]
        if len(sub) >= 26:
            macd_hist.append(_ema(sub, 12) - _ema(sub, 26))
    if len(macd_hist) < 2:
        return round(macd_line, 4), round(macd_line * 0.9, 4), round(macd_line * 0.1, 4), "neutral"

    signal = _ema(np.array(macd_hist + [macd_line]), 9)
    histogram = macd_line - signal
    direction = "bullish" if histogram > 0 else "bearish" if histogram < 0 else "neutral"
    return round(macd_line, 4), round(signal, 4), round(histogram, 4), direction


def _vwap(df) -> Optional[float]:
    """Session VWAP — NYSE open to now."""
    try:
        if "volume" not in df.columns or df["volume"].sum() == 0:
            return None
        now = datetime.now(timezone.utc)
        # NYSE open: 13:30 UTC
        session_start = now.replace(hour=13, minute=30, second=0, microsecond=0)
        if session_start > now:
            session_start -= timedelta(days=1)
        today = df[df.index >= session_start]
        if today.empty or today["volume"].sum() == 0:
            today = df.tail(100)  # fallback
        if today.empty or today["volume"].sum() == 0:
            return None
        typical = (today["high"] + today["low"] + today["close"]) / 3
        return float((typical * today["volume"]).sum() / today["volume"].sum())
    except Exception:
        return None


def _bollinger(closes: np.ndarray, period: int = 20) -> dict:
    arr = closes.astype(float)
    if len(arr) < period:
        mid = float(arr[-1])
        return {"upper": mid, "middle": mid, "lower": mid, "pct_b": 0.5, "width_pct": 0.0}
    window = arr[-period:]
    mid = float(np.mean(window))
    std = float(np.std(window))
    upper = mid + 2 * std
    lower = mid - 2 * std
    pct_b = (arr[-1] - lower) / (upper - lower) if upper != lower else 0.5
    width_pct = (upper - lower) / mid * 100 if mid > 0 else 0.0
    return {
        "upper": round(upper, 4),
        "middle": round(mid, 4),
        "lower": round(lower, 4),
        "pct_b": round(pct_b, 3),   # 0=lower band, 0.5=midline, 1=upper band
        "width_pct": round(width_pct, 2),
    }


def _support_resistance(df, current_price: float, n: int = 2):
    """Pivot-point support and resistance from today's 1-min bars."""
    highs = df["high"].values.astype(float)
    lows = df["low"].values.astype(float)
    resistance, support = [], []
    for i in range(2, len(highs) - 2):
        if highs[i] > highs[i-1] and highs[i] > highs[i-2] and highs[i] > highs[i+1] and highs[i] > highs[i+2]:
            if highs[i] > current_price * 1.001:
                resistance.append(round(float(highs[i]), 2))
        if lows[i] < lows[i-1] and lows[i] < lows[i-2] and lows[i] < lows[i+1] and lows[i] < lows[i+2]:
            if lows[i] < current_price * 0.999:
                support.append(round(float(lows[i]), 2))
    # Deduplicate within 0.2% tolerance
    def dedup(levels, reverse=False):
        levels = sorted(set(levels), reverse=reverse)
        result = []
        for lv in levels:
            if not result or abs(lv - result[-1]) / result[-1] > 0.002:
                result.append(lv)
        return result[:n]
    return {
        "support": dedup(support, reverse=True),    # nearest first
        "resistance": dedup(resistance),             # nearest first
    }


def _composite_signal(prob_up: float, rsi: float, macd_dir: str, vwap: Optional[float],
                       current_price: float, bb_pct_b: float, ema9: float, ema21: float,
                       news_adj: float) -> tuple[str, float]:
    """
    Multi-factor score → BUY / HOLD / SELL.
    Returns (signal, score) where score is -1 to +1.
    """
    score = 0.0

    # 1. Momentum (most important for intraday)
    score += (prob_up - 0.5) * 1.2          # ±0.6 max

    # 2. RSI — oversold bounce or overbought fade
    if rsi <= 30:
        score += 0.35
    elif rsi <= 40:
        score += 0.15
    elif rsi >= 70:
        score -= 0.35
    elif rsi >= 60:
        score -= 0.15

    # 3. MACD crossover direction
    if macd_dir == "bullish":
        score += 0.20
    elif macd_dir == "bearish":
        score -= 0.20

    # 4. VWAP position — institutions anchor to VWAP
    if vwap and vwap > 0:
        vwap_pct = (current_price - vwap) / vwap * 100
        if vwap_pct < -1.0:     # 1%+ below VWAP → mean-reversion buy pressure
            score += 0.20
        elif vwap_pct < -0.3:
            score += 0.08
        elif vwap_pct > 1.0:    # 1%+ above VWAP → overbought relative to institutions
            score -= 0.20
        elif vwap_pct > 0.3:
            score -= 0.08

    # 5. Bollinger Bands position
    if bb_pct_b <= 0.05:        # touching lower band → potential bounce
        score += 0.15
    elif bb_pct_b >= 0.95:      # touching upper band → potential rejection
        score -= 0.15

    # 6. EMA 9/21 crossover
    if ema9 > ema21 * 1.001:    # short EMA above long → uptrend
        score += 0.10
    elif ema9 < ema21 * 0.999:
        score -= 0.10

    # 7. News sentiment
    score += news_adj * 0.5     # small weight — news is already in prob_up

    score = max(-1.0, min(1.0, score))

    if score >= 0.25:
        return "BUY", score
    elif score <= -0.25:
        return "SELL", score
    else:
        return "HOLD", score


# ── Endpoints ───────────────────────────────────────────────────────────────

@router.get("/{ticker}/analysis")
def quick_analysis(
    ticker: str,
    buy_price: Optional[float] = Query(None),
    db: Session = Depends(get_db),
):
    ticker = ticker.upper()

    try:
        df = fetch_and_cache_bars(db, ticker, timeframe="1Min", days_back=2)
    except Exception:
        df = get_cached_bars(db, ticker, timeframe="1Min", limit=500)

    if df.empty or len(df) < 20:
        raise HTTPException(status_code=422, detail="Not enough price data for this ticker")

    live_price = get_latest_price(ticker)
    current_price = live_price if live_price else float(df["close"].iloc[-1])
    closes = df["close"].values.astype(float)
    returns = np.diff(closes) / closes[:-1]

    # ── Technical indicators ──────────────────────────────────────────────
    rsi_val = _rsi(closes)
    ema9_val = _ema(closes, 9)
    ema21_val = _ema(closes, 21)
    macd_line, macd_signal, macd_hist, macd_dir = _macd(closes)
    vwap_val = _vwap(df)
    bb = _bollinger(closes)
    sr = _support_resistance(df.tail(200), current_price)  # use most recent 200 bars

    # ── Momentum ─────────────────────────────────────────────────────────
    recent_ret = returns[-30:] if len(returns) >= 30 else returns
    prob_up_raw = float(np.mean(recent_ret > 0)) if len(recent_ret) > 0 else 0.5

    # ── News sentiment ────────────────────────────────────────────────────
    news = get_cached_news(db, ticker, limit=10,
                           since=datetime.now(timezone.utc) - timedelta(hours=24))
    scored = [n for n in news if n.sentiment_cached and n.sentiment_score is not None]
    news_adj = 0.0
    if scored:
        avg_sentiment = float(np.mean([n.sentiment_score for n in scored]))
        news_adj = avg_sentiment * 0.08

    prob_up = min(0.88, max(0.12, prob_up_raw + news_adj))
    prob_down = 1 - prob_up

    # ── Composite signal ──────────────────────────────────────────────────
    signal, signal_score = _composite_signal(
        prob_up, rsi_val, macd_dir, vwap_val, current_price,
        bb["pct_b"], ema9_val, ema21_val, news_adj
    )

    # ── Expected move (realized vol) ──────────────────────────────────────
    vol_per_bar = float(np.std(returns[-60:])) if len(returns) >= 10 else 0.001
    vol_1h = vol_per_bar * sqrt(60)
    vol_eod = vol_per_bar * sqrt(max(1, len(df.between_time("09:30", "16:00")) or 60))
    vol_1d = vol_per_bar * sqrt(390)

    def price_range(vol):
        return {
            "low": round(current_price * (1 - 1.5 * vol), 2),
            "high": round(current_price * (1 + 1.5 * vol), 2),
            "expected_move_pct": round(vol * 100, 2),
        }

    # ── Buy price analysis ────────────────────────────────────────────────
    buy_analysis = None
    if buy_price:
        dist_pct = (current_price - buy_price) / buy_price * 100
        upside_1d = current_price * (1 + vol_1d * prob_up) - buy_price
        downside_1d = buy_price - current_price * (1 - vol_1d * prob_down)
        no_floor_risk = downside_1d <= 0
        risk_reward = upside_1d / downside_1d if downside_1d > 0 else None
        ba_signal = "BUY" if (signal == "BUY" and (no_floor_risk or (risk_reward or 0) >= 1.5)) else \
                    "WAIT" if signal == "SELL" else "NEUTRAL"
        buy_analysis = {
            "buy_price": buy_price,
            "current_price": current_price,
            "distance_pct": round(dist_pct, 2),
            "upside_1d": round(upside_1d, 2),
            "downside_1d": round(downside_1d, 2),
            "risk_reward": round(risk_reward, 2) if risk_reward is not None else None,
            "signal": ba_signal,
            "signal_color": "green" if ba_signal == "BUY" else "red" if ba_signal == "WAIT" else "yellow",
        }

    # ── VWAP context ──────────────────────────────────────────────────────
    vwap_context = None
    if vwap_val:
        vwap_dist = (current_price - vwap_val) / vwap_val * 100
        vwap_context = {
            "vwap": round(vwap_val, 2),
            "distance_pct": round(vwap_dist, 2),
            "position": "above" if vwap_dist > 0.1 else "below" if vwap_dist < -0.1 else "at",
        }

    return {
        "ticker": ticker,
        "current_price": current_price,
        "signal": signal,
        "signal_score": round(signal_score, 3),
        "prob_up": round(prob_up * 100, 1),
        "prob_down": round(prob_down * 100, 1),
        "momentum": "bullish" if prob_up_raw > 0.55 else "bearish" if prob_up_raw < 0.45 else "neutral",
        "news_sentiment": round(news_adj / 0.08, 2) if scored else None,
        "technicals": {
            "rsi": rsi_val,
            "rsi_signal": "oversold" if rsi_val < 35 else "overbought" if rsi_val > 65 else "neutral",
            "macd": {"line": macd_line, "signal": macd_signal, "histogram": macd_hist, "direction": macd_dir},
            "ema9": round(ema9_val, 2),
            "ema21": round(ema21_val, 2),
            "ema_cross": "bullish" if ema9_val > ema21_val * 1.001 else "bearish" if ema9_val < ema21_val * 0.999 else "neutral",
            "bollinger": bb,
            "vwap": vwap_context,
            "support_resistance": sr,
        },
        "ranges": {
            "1h": price_range(vol_1h),
            "eod": price_range(vol_eod),
            "1d": price_range(vol_1d),
        },
        "buy_analysis": buy_analysis,
        "bars_used": len(df),
        "computed_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/{ticker}/forecast")
def quick_forecast(ticker: str, db: Session = Depends(get_db)):
    """
    VWAP-anchored forecast blended with momentum drift.

    Short-term (≤30 min): momentum dominates — recent price direction continues.
    Medium-term (30–120 min): blend — momentum fades, VWAP pull increases.
    Long-term (120+ min): VWAP reversion dominates — price gravitates toward
      the session average (how professional intraday models work).
    """
    ticker = ticker.upper()

    try:
        df = fetch_and_cache_bars(db, ticker, timeframe="1Min", days_back=2)
    except Exception:
        df = get_cached_bars(db, ticker, timeframe="1Min", limit=500)

    if df.empty or len(df) < 20:
        raise HTTPException(status_code=422, detail="Not enough price data for this ticker")

    live_price = get_latest_price(ticker)
    current_price = live_price if live_price else float(df["close"].iloc[-1])
    closes = df["close"].values.astype(float)
    returns = np.diff(closes) / closes[:-1]

    vol_per_bar = float(np.std(returns[-60:])) if len(returns) >= 10 else 0.001
    recent = returns[-30:] if len(returns) >= 30 else returns
    prob_up = float(np.mean(recent > 0)) if len(recent) > 0 else 0.5

    # RSI adjustment: overbought = reduce bullish drift, oversold = reduce bearish drift
    rsi_val = _rsi(closes)
    if rsi_val > 70 and prob_up > 0.5:
        prob_up = max(0.5, prob_up - 0.08)     # fade overbought momentum
    elif rsi_val < 30 and prob_up < 0.5:
        prob_up = min(0.5, prob_up + 0.08)     # fade oversold selling

    # News sentiment
    news = get_cached_news(db, ticker, limit=10,
                           since=datetime.now(timezone.utc) - timedelta(hours=24))
    scored = [n for n in news if n.sentiment_cached and n.sentiment_score is not None]
    if scored:
        avg_sentiment = float(np.mean([n.sentiment_score for n in scored]))
        prob_up = min(0.88, max(0.12, prob_up + avg_sentiment * 0.06))

    drift_per_bar = (prob_up - 0.5) * vol_per_bar

    # VWAP for reversion anchor
    vwap_val = _vwap(df)
    vwap_pull = (vwap_val - current_price) / current_price if vwap_val else 0.0

    now = datetime.now(timezone.utc)
    MAX_DRIFT = 0.025   # hard cap: ±2.5% max projected move

    # Anchor target_time to the LAST BAR's timestamp, not datetime.now().
    # When the market is closed, now() is hours after the last bar, which would
    # place all forecast points far to the right (or after midnight) and create a
    # giant gap on the chart. Using the last bar keeps the forecast glued to the
    # most recent candle regardless of when the user is viewing.
    last_bar_ts = df.index[-1]
    if getattr(last_bar_ts, "tzinfo", None) is None:
        last_bar_ts = last_bar_ts.replace(tzinfo=timezone.utc)
    anchor_time = last_bar_ts.to_pydatetime() if hasattr(last_bar_ts, "to_pydatetime") else last_bar_ts

    forecast_points = []
    for h in FORECAST_HORIZONS:
        vol_h = vol_per_bar * sqrt(h)

        # Blend factor: 0 = pure momentum (short-term), 1 = pure VWAP reversion (long-term)
        # Transitions from momentum-dominated at 15 min → VWAP-dominated at 2+ hours
        alpha = min(1.0, h / 120.0)

        momentum_drift = drift_per_bar * h
        reversion_drift = vwap_pull * (1 - np.exp(-h / 90))  # asymptotic pull toward VWAP

        drift_h = (1 - alpha) * momentum_drift + alpha * reversion_drift
        drift_h = max(-MAX_DRIFT, min(MAX_DRIFT, drift_h))

        predicted_price = current_price * (1 + drift_h)

        forecast_points.append({
            "horizon_minutes": h,
            "target_time": (anchor_time + timedelta(minutes=h)).isoformat(),
            "predicted_price": round(predicted_price, 4),
            "lower_50": round(current_price * (1 + drift_h - 0.674 * vol_h), 4),
            "upper_50": round(current_price * (1 + drift_h + 0.674 * vol_h), 4),
            "lower_80": round(current_price * (1 + drift_h - 1.282 * vol_h), 4),
            "upper_80": round(current_price * (1 + drift_h + 1.282 * vol_h), 4),
        })

    return {
        "ticker": ticker,
        "current_price": current_price,
        "forecast_points": forecast_points,
        "model": "vwap_momentum_blend",
        "vwap": round(vwap_val, 2) if vwap_val else None,
        "computed_at": now.isoformat(),
        "anchor_bar_time": anchor_time.isoformat(),
    }


@router.get("/{ticker}/summary")
def stock_summary(ticker: str, db: Session = Depends(get_db)):
    ticker = ticker.upper()
    now = datetime.now(timezone.utc)

    # Live price is the authoritative current price — bar closes from IEX are unreliable
    # for illiquid stocks that trade primarily on other exchanges.
    live_price = get_latest_price(ticker)

    # 1D window: from today's market open (13:30 UTC = 9:30 AM ET) so we only
    # show today's session, not yesterday's bars bleeding in.
    today_open = now.replace(hour=13, minute=30, second=0, microsecond=0)
    if today_open > now:
        today_open -= timedelta(days=1)

    period_starts = {
        "1D": today_open,
        "1W": now - timedelta(days=8),
        "1M": now - timedelta(days=35),
        "3M": now - timedelta(days=95),
        "1Y": now - timedelta(days=370),
    }
    periods = {
        "1D":  {"tf": "1Min",  "limit": 500},
        "1W":  {"tf": "1Day",  "limit": 5},
        "1M":  {"tf": "1Day",  "limit": 22},
        "3M":  {"tf": "1Day",  "limit": 66},
        "1Y":  {"tf": "1Day",  "limit": 252},
    }

    result = {}
    bar_current_price = None

    for label, cfg in periods.items():
        try:
            # Use DB cache — it's populated by refresh calls and is more complete
            # than a fresh IEX call which misses trades on other exchanges.
            start = period_starts[label]
            df = get_cached_bars(db, ticker, timeframe=cfg["tf"], limit=cfg["limit"], start=start)
            if df.empty or len(df) < 2:
                result[label] = None
                continue
            open_price = float(df["open"].iloc[0])
            close_price = float(df["close"].iloc[-1])
            if bar_current_price is None:
                bar_current_price = close_price
            # For 1D, use live_price as close so stats reflect actual current price
            display_close = live_price if (label == "1D" and live_price) else close_price
            change_pct = (display_close - open_price) / open_price * 100 if open_price else 0
            result[label] = {
                "open": round(open_price, 2),
                "close": round(display_close, 2),
                "high": round(max(float(df["high"].max()), display_close), 2),
                "low": round(min(float(df["low"].min()), display_close), 2),
                "change_pct": round(change_pct, 2),
                "volume": int(df["volume"].sum()),
            }
        except Exception as e:
            logger.debug("Summary period %s failed: %s", label, e)
            result[label] = None

    current_price = live_price or bar_current_price
    return {"ticker": ticker, "current_price": current_price, "periods": result}
