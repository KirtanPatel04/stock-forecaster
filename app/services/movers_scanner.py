"""Scans a universe of liquid tickers for bullish after-hours/pre-market news
and ranks them by potential for a positive move at the next market open.
"""
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

import numpy as np
from math import sqrt

from ..data.market_router import get_bars, get_bars_multi, get_latest_price, get_market_universe, get_market_movers
from ..data.data_manager import fetch_and_cache_news, get_cached_news
from ..forecasting.claude_sentiment import score_news, score_news_batch_gemini
from ..config import settings

logger = logging.getLogger(__name__)

# Fallback universe — top TSX stocks used when the live screener is unavailable.
FALLBACK_UNIVERSE = [
    "RY.TO", "TD.TO", "BNS.TO", "BMO.TO", "CM.TO", "NA.TO",
    "SU.TO", "CNQ.TO", "CVE.TO", "TOU.TO", "ARX.TO",
    "SHOP.TO", "CSU.TO", "OTEX.TO",
    "BCE.TO", "T.TO",
    "ABX.TO", "K.TO", "FNV.TO", "WPM.TO",
    "MFC.TO", "SLF.TO", "GWO.TO", "IFC.TO",
    "BAM.TO", "BN.TO", "CP.TO", "CNR.TO", "AC.TO",
    "MRU.TO", "L.TO", "ATD.TO", "GIB.TO", "EMA.TO",
    "ENB.TO", "TRP.TO", "PPL.TO",
]

MIN_RELEVANCE = 0.35
MIN_COMPOSITE = 0.08


def scan_top_picks(
    db: Session,
    extra_tickers: Optional[list[str]] = None,
    limit: int = 8,
    lookback_hours: int = 16,
    max_price: Optional[float] = None,
) -> list[dict]:
    live = get_market_universe(top=100)
    movers = get_market_movers()
    base = live + movers if (live or movers) else FALLBACK_UNIVERSE
    universe = list(dict.fromkeys(base + FALLBACK_UNIVERSE + [t.upper() for t in (extra_tickers or [])]))
    since = datetime.now(timezone.utc) - timedelta(hours=lookback_hours)

    ticker_news: dict[str, list] = {}
    for ticker in universe:
        items = get_cached_news(db, ticker, limit=6, since=since)
        if not items:
            try:
                fetch_and_cache_news(db, ticker, days_back=2)
            except Exception as e:
                logger.debug("News fetch failed for %s: %s", ticker, e)
            items = get_cached_news(db, ticker, limit=6, since=since)
        if items:
            ticker_news[ticker] = items

    # Score uncached headlines — batch per ticker (1 API call per ticker, not per article).
    def _score_ticker_batch(ticker: str, items: list) -> None:
        uncached = [it for it in items if not it.sentiment_cached]
        if not uncached:
            return
        articles = [{"headline": it.headline, "summary": it.summary or ""} for it in uncached]
        try:
            if settings.gemini_api_key:
                scores = score_news_batch_gemini(ticker, articles)
            else:
                scores = [score_news(ticker, a["headline"], a["summary"]) for a in articles]
            for item, result in zip(uncached, scores):
                item.relevance_score = result["relevance"]
                item.sentiment_score = result["sentiment"]
                item.surprise_level = result["surprise"]
                item.expected_impact = result["expected_impact"]
                item.sentiment_cached = True
        except Exception as e:
            logger.warning("Batch scoring failed for %s, falling back per-item: %s", ticker, e)
            for item in uncached:
                try:
                    result = score_news(ticker, item.headline, item.summary or "")
                    item.relevance_score = result["relevance"]
                    item.sentiment_score = result["sentiment"]
                    item.surprise_level = result["surprise"]
                    item.expected_impact = result["expected_impact"]
                    item.sentiment_cached = True
                except Exception:
                    pass

    has_uncached = any(not it.sentiment_cached for items in ticker_news.values() for it in items)
    if has_uncached:
        with ThreadPoolExecutor(max_workers=8) as ex:
            list(ex.map(lambda kv: _score_ticker_batch(kv[0], kv[1]), ticker_news.items()))
        db.commit()

    scored_picks = []
    for ticker, items in ticker_news.items():
        qualifying = [it for it in items if (it.relevance_score or 0) >= MIN_RELEVANCE]
        total_relevance = sum(it.relevance_score for it in qualifying)
        if not qualifying or total_relevance <= 0:
            continue

        weighted_sentiment = sum((it.sentiment_score or 0) * it.relevance_score for it in qualifying) / total_relevance
        avg_impact = sum((it.expected_impact or 0) * it.relevance_score for it in qualifying) / total_relevance
        confidence = min(1.0, total_relevance / 1.5)
        composite = weighted_sentiment * confidence * (0.4 + 0.6 * avg_impact)

        if composite < MIN_COMPOSITE:
            continue

        top_item = max(qualifying, key=lambda it: it.relevance_score * abs(it.sentiment_score or 0))
        expected_move_pct = max(0.0, min(0.15, weighted_sentiment * avg_impact * 0.3))

        scored_picks.append({
            "ticker": ticker,
            "composite_score": round(composite, 3),
            "sentiment": round(weighted_sentiment, 3),
            "confidence": round(confidence, 2),
            "expected_move_pct": round(expected_move_pct * 100, 2),
            "news_count": len(qualifying),
            "top_headline": top_item.headline,
            "top_source": top_item.source,
            "reasons": [
                it.headline for it in sorted(qualifying, key=lambda x: x.relevance_score, reverse=True)[:3]
            ],
        })

    scored_picks.sort(key=lambda p: p["composite_score"], reverse=True)

    # Fetch prices first so we can filter by affordability before returning
    enriched = []
    for pick in scored_picks:
        last_price = get_latest_price(pick["ticker"])
        if max_price is not None and last_price is not None and last_price > max_price:
            continue
        pick["last_price"] = last_price
        pick["price_history"] = _get_recent_closes(pick["ticker"])
        pick["target_price"] = (
            round(last_price * (1 + pick["expected_move_pct"] / 100), 2) if last_price else None
        )
        enriched.append(pick)
        if len(enriched) >= limit:
            break

    return enriched


def _get_recent_closes(ticker: str, days_back: int = 5, timeframe: str = "5Min", max_points: int = 24) -> list[float]:
    """Closes from the most recent trading session, for a sparkline.

    Windows off a fixed hour count (e.g. "last 6 hours") land in a gap with zero
    bars whenever the market's currently closed — free-tier IEX has no extended-hours
    data, so nights/weekends produce nothing. Look back several days instead and take
    the tail, and don't cap the API `limit` below the window size — Alpaca returns
    bars in ascending order, so a tight limit would truncate to the *oldest* bars in
    the window rather than the most recent ones.
    """
    try:
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=days_back)
        df = get_bars(ticker, timeframe=timeframe, start=start, end=end, limit=1000)
        if df.empty:
            return []
        return [round(float(c), 4) for c in df["close"].tail(max_points).tolist()]
    except Exception as e:
        logger.debug("Price history fetch failed for %s: %s", ticker, e)
        return []


def scan_intraday_picks(
    db: Session,
    extra_tickers: Optional[list[str]] = None,
    limit: int = 8,
    max_price: Optional[float] = None,
) -> list[dict]:
    """
    Ranks tickers by live intraday momentum — how likely each is to move UP.

    Universe: today's most-active stocks from the Alpaca screener (i.e. stocks
    that are actually moving today), merged with any extra tickers the caller
    provides. Falls back to a static list when the screener is unavailable.

    max_price: if set, exclude stocks the user can't afford (price > max_price).
    """
    # Live universe: today's most-active + top movers + caller extras
    live = get_market_universe(top=100)
    movers = get_market_movers()
    if not live and not movers:
        live = FALLBACK_UNIVERSE
    universe = list(dict.fromkeys(
        live + movers + [t.upper() for t in (extra_tickers or [])]
    ))

    now = datetime.now(timezone.utc)
    session_start = now - timedelta(hours=8)

    # Batched multi-symbol requests. One request per ticker (~140) blows through
    # Alpaca's free-tier 200 req/min limit and the SDK's silent 429 retries turned
    # the scan into a 2+ minute wait. Only the session window is fetched — no
    # `limit`, since on multi-symbol requests it caps total bars across all symbols.
    def _fetch(chunk: list[str]) -> dict:
        try:
            return get_bars_multi(chunk, timeframe="5Min", start=session_start, end=now, limit=None)
        except Exception as e:
            logger.debug("Bar fetch failed for %s: %s", chunk, e)
            return {}

    chunks = [universe[i:i + 50] for i in range(0, len(universe), 50)]
    bars_map: dict = {}
    with ThreadPoolExecutor(max_workers=4) as executor:
        for result in executor.map(_fetch, chunks):
            bars_map.update(result)
    picks = []

    for ticker in universe:
        df = bars_map.get(ticker)
        if df is None or df.empty:
            continue

        today_df = df[df.index >= session_start]
        if len(today_df) < 6:
            continue

        closes = today_df["close"].values.astype(float)
        volumes = today_df["volume"].values.astype(float)
        returns = np.diff(closes) / closes[:-1]
        if len(returns) < 5:
            continue

        current_price = float(closes[-1])

        # Skip if the user can't afford even 1 share
        if max_price is not None and current_price > max_price:
            continue

        recent_returns = returns[-20:]
        prob_up = float(np.mean(recent_returns > 0))
        if prob_up < 0.52:
            continue

        last4 = float(np.mean(recent_returns[-4:] > 0)) if len(recent_returns) >= 4 else prob_up
        prev10 = float(np.mean(recent_returns[-14:-4] > 0)) if len(recent_returns) >= 14 else prob_up
        accelerating = last4 > prev10

        session_open = float(today_df["open"].iloc[0])
        pct_from_open = (current_price - session_open) / session_open * 100
        if pct_from_open > 4.0:
            continue

        vol_surge = (
            float(volumes[-1]) / float(np.mean(volumes[-10:]))
            if len(volumes) >= 10 and np.mean(volumes[-10:]) > 0 else 1.0
        )

        vol_per_bar = float(np.std(returns[-20:])) if len(returns) >= 5 else 0.005
        drift_per_bar = float(np.mean(recent_returns[-10:])) if len(recent_returns) >= 10 else 0.0

        # Per-horizon expected move (1 sigma, annualised to each window)
        # 5-min bars: sqrt(N bars) × vol_per_bar
        exp_15min = round(vol_per_bar * sqrt(3) * 100, 2)    # 3 × 5-min bars
        exp_1hr   = round(vol_per_bar * sqrt(12) * 100, 2)   # 12 × 5-min bars
        exp_1day  = round(vol_per_bar * sqrt(78) * 100, 2)   # 78 × 5-min bars (full session)

        # Direction-adjusted drift targets per horizon
        drift_15min = max(0.0, drift_per_bar * 3)
        drift_1hr   = max(0.0, drift_per_bar * 12)
        drift_1day  = max(0.0, drift_per_bar * 78)

        target_15min = round(current_price * (1 + drift_15min + vol_per_bar * 0.3), 2)
        target_1hr   = round(current_price * (1 + drift_1hr   + vol_per_bar * 0.5), 2)
        target_1day  = round(current_price * (1 + drift_1day  + vol_per_bar * 1.0), 2)

        news = get_cached_news(db, ticker, limit=5, since=now - timedelta(hours=8))
        news_bonus = 0.0
        if news:
            scored = [n for n in news if n.sentiment_cached and n.sentiment_score is not None]
            if scored:
                news_bonus = float(np.mean([n.sentiment_score for n in scored])) * 0.15

        score = (
            (prob_up - 0.5) * 2.0
            + (0.15 if accelerating else 0)
            + min(0.2, (vol_surge - 1.0) * 0.1)
            + news_bonus
        )

        price_history = [round(float(c), 4) for c in closes[-24:].tolist()]

        picks.append({
            "ticker": ticker,
            "score": round(score, 3),
            "prob_up": round(prob_up * 100, 1),
            "momentum": "bullish" if prob_up > 0.60 else "leaning bullish",
            "accelerating": accelerating,
            "current_price": round(current_price, 2),
            "pct_from_open": round(pct_from_open, 2),
            "vol_surge": round(vol_surge, 2),
            # Per-horizon expected % move and price target
            "expected_move_pct": exp_1hr,   # kept for backwards compat
            "horizons": {
                "15min": {"expected_move_pct": exp_15min, "target_price": target_15min},
                "1hr":   {"expected_move_pct": exp_1hr,   "target_price": target_1hr},
                "1day":  {"expected_move_pct": exp_1day,  "target_price": target_1day},
            },
            "target_price": target_1hr,     # backwards compat
            "price_history": price_history,
            "news_bonus": round(news_bonus, 3),
            "bars_today": len(today_df),
        })

    picks.sort(key=lambda p: p["score"], reverse=True)
    return picks[:limit]
