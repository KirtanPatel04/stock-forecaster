"""After-hours / pre-market analysis — aggregates data sources and calls Claude."""
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from ..data.alpaca_client import get_bars, get_latest_price
from ..data.data_manager import fetch_and_cache_news, get_cached_news, sync_earnings_calendar
from ..data.finnhub_client import get_earnings_calendar, get_economic_calendar, get_recommendation_trends, get_option_chain_summary
from ..data.sec_edgar import get_recent_8k
from ..forecasting.claude_sentiment import score_news_cached, summarize_news_for_report
from ..models.db_models import AfterHoursReport, EarningsEvent
from ..models.schemas import AfterHoursReportOut

logger = logging.getLogger(__name__)


def build_afterhours_report(db: Session, ticker: str) -> AfterHoursReportOut:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    existing = (
        db.query(AfterHoursReport)
        .filter(AfterHoursReport.ticker == ticker, AfterHoursReport.report_date == today)
        .first()
    )
    if existing:
        return AfterHoursReportOut.model_validate(existing)

    # --- Gather data ---
    # 1. After-hours and pre-market price action
    ah_context = _get_price_context(ticker)

    # 2. Recent news (fetch then score all uncached items in parallel)
    try:
        fetch_and_cache_news(db, ticker, days_back=2)
    except Exception as e:
        logger.warning("News fetch failed: %s", e)
    since = datetime.now(timezone.utc) - timedelta(days=2)
    news_items = get_cached_news(db, ticker, limit=30, since=since)
    uncached = [item for item in news_items if not item.sentiment_cached]
    if uncached:
        def _score_one(item):
            from ..forecasting.claude_sentiment import score_news
            return item, score_news(item.ticker or "", item.headline, item.summary or "")

        with ThreadPoolExecutor(max_workers=min(8, len(uncached))) as pool:
            futures = {pool.submit(_score_one, item): item for item in uncached}
            for future in as_completed(futures):
                try:
                    item, result = future.result()
                    item.relevance_score = result["relevance"]
                    item.sentiment_score = result["sentiment"]
                    item.surprise_level = result["surprise"]
                    item.expected_impact = result["expected_impact"]
                    item.sentiment_cached = True
                except Exception:
                    pass
        db.commit()

    # 3–7. Gather remaining data in parallel
    def _get_earnings():
        try:
            sync_earnings_calendar(db, ticker)
        except Exception:
            pass
        return _get_recent_earnings(db, ticker), _get_upcoming_earnings(db, ticker)

    def _get_analyst():
        try:
            return get_recommendation_trends(ticker)
        except Exception:
            return []

    def _get_sec():
        try:
            return get_recent_8k(ticker, days_back=7)
        except Exception:
            return []

    def _get_macro():
        try:
            events = get_economic_calendar(months_ahead=1)
            return [e for e in events if e.get("impact", "") in ("HIGH", "MEDIUM")][:5]
        except Exception:
            return []

    def _get_iv():
        try:
            return get_option_chain_summary(ticker)
        except Exception:
            return {}

    with ThreadPoolExecutor(max_workers=5) as pool:
        f_earnings = pool.submit(_get_earnings)
        f_analyst = pool.submit(_get_analyst)
        f_sec = pool.submit(_get_sec)
        f_macro = pool.submit(_get_macro)
        f_iv = pool.submit(_get_iv)

        (recent_earnings, upcoming_earnings) = f_earnings.result()
        analyst_ratings = f_analyst.result()
        sec_filings = f_sec.result()
        macro_events = f_macro.result()
        iv_data = f_iv.result()

    # Build context string for Claude
    context_parts = [f"Ticker: {ticker}"]
    context_parts.append(f"Price context: {ah_context}")
    if recent_earnings:
        context_parts.append(f"Recent earnings: {recent_earnings}")
    if upcoming_earnings:
        context_parts.append(f"Next earnings: {upcoming_earnings}")
    if analyst_ratings:
        latest = analyst_ratings[0]
        context_parts.append(f"Analyst consensus: {latest.get('buy', 0)} buy / {latest.get('hold', 0)} hold / {latest.get('sell', 0)} sell")
    if sec_filings:
        context_parts.append(f"Recent 8-K filings: {len(sec_filings)} in past 7 days")
    if macro_events:
        context_parts.append(f"Upcoming macro events: {[e.get('event', '') for e in macro_events[:3]]}")
    if iv_data.get("beta"):
        context_parts.append(f"Beta: {iv_data['beta']:.2f}")

    context_str = "\n".join(context_parts)
    news_dicts = [
        {"source": n.source, "headline": n.headline, "summary": n.summary or ""}
        for n in news_items
    ]

    # Call Claude
    claude_result = summarize_news_for_report(ticker, news_dicts, context=context_str)

    last_close = _get_last_close(ticker)
    expected_low = last_close * (1 + claude_result.get("expected_change_low", -0.02)) if last_close else 0.0
    expected_high = last_close * (1 + claude_result.get("expected_change_high", 0.02)) if last_close else 0.0

    report = AfterHoursReport(
        ticker=ticker,
        report_date=today,
        lean=claude_result.get("lean", "neutral"),
        probability=float(claude_result.get("probability", 0.5)),
        expected_low=expected_low,
        expected_high=expected_high,
        key_reasons=claude_result.get("key_reasons", []),
        full_report={
            "price_context": ah_context,
            "news_count": len(news_items),
            "recent_earnings": recent_earnings,
            "upcoming_earnings": upcoming_earnings,
            "analyst_ratings": analyst_ratings[:3] if analyst_ratings else [],
            "sec_filings": len(sec_filings),
            "macro_events": [e.get("event", "") for e in macro_events[:3]],
            "iv_data": iv_data,
            "summary": claude_result.get("summary", ""),
            "news_items": news_dicts[:10],
        },
    )
    db.add(report)
    db.commit()
    db.refresh(report)

    return AfterHoursReportOut.model_validate(report)


def score_past_reports(db: Session) -> int:
    """Score past after-hours reports against the actual opening price."""
    from ..data.alpaca_client import get_bars as _get_bars
    import pandas as pd
    from datetime import timezone

    now = datetime.now(timezone.utc)
    reports = (
        db.query(AfterHoursReport)
        .filter(
            AfterHoursReport.actual_open.is_(None),
            AfterHoursReport.created_at < now - timedelta(hours=8),
        )
        .all()
    )
    scored = 0
    for r in reports:
        try:
            date = datetime.strptime(r.report_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            open_time = date.replace(hour=13, minute=30)  # 9:30 ET = 13:30 UTC
            df = _get_bars(r.ticker, timeframe="1Min", start=open_time, end=open_time + timedelta(hours=1), limit=5)
            if df.empty:
                continue
            actual_open = float(df["open"].iloc[0])
            prev_close = _get_last_close(r.ticker, as_of=date - timedelta(days=1))
            r.actual_open = actual_open
            if prev_close:
                r.actual_direction_correct = bool(
                    (actual_open > prev_close) == (r.lean == "bullish")
                    or (actual_open < prev_close) == (r.lean == "bearish")
                )
            scored += 1
        except Exception as e:
            logger.debug("Could not score report %d: %s", r.id, e)
    if scored:
        db.commit()
    return scored


def _get_price_context(ticker: str) -> str:
    try:
        end = datetime.now(timezone.utc)
        start = end - timedelta(hours=20)
        df = get_bars(ticker, timeframe="5Min", start=start, end=end, limit=100)
        if df.empty:
            return "No extended-hours data"
        last_close = float(df["close"].iloc[-1])
        day_high = float(df["high"].max())
        day_low = float(df["low"].min())
        total_vol = float(df["volume"].sum())
        return (
            f"Last price: ${last_close:.2f}, "
            f"Range: ${day_low:.2f}–${day_high:.2f}, "
            f"Volume (extended hrs): {total_vol:,.0f}"
        )
    except Exception as e:
        return f"Price data unavailable: {e}"


def _get_last_close(ticker: str, as_of: Optional[datetime] = None) -> Optional[float]:
    try:
        end = as_of or datetime.now(timezone.utc)
        start = end - timedelta(days=5)
        df = get_bars(ticker, timeframe="1Day", start=start, end=end, limit=3)
        if not df.empty:
            return float(df["close"].iloc[-1])
        return get_latest_price(ticker)
    except Exception:
        return None


def _get_recent_earnings(db: Session, ticker: str) -> Optional[dict]:
    now = datetime.now(timezone.utc)
    event = (
        db.query(EarningsEvent)
        .filter(
            EarningsEvent.ticker == ticker,
            EarningsEvent.earnings_date <= now,
            EarningsEvent.earnings_date >= now - timedelta(days=30),
        )
        .order_by(EarningsEvent.earnings_date.desc())
        .first()
    )
    if not event:
        return None
    result = {"date": event.earnings_date.strftime("%Y-%m-%d")}
    if event.eps_actual is not None and event.eps_estimate is not None:
        result["eps_actual"] = event.eps_actual
        result["eps_estimate"] = event.eps_estimate
        result["eps_surprise_pct"] = round(
            (event.eps_actual - event.eps_estimate) / abs(event.eps_estimate) * 100, 1
        ) if event.eps_estimate else None
    return result


def _get_upcoming_earnings(db: Session, ticker: str) -> Optional[str]:
    now = datetime.now(timezone.utc)
    event = (
        db.query(EarningsEvent)
        .filter(EarningsEvent.ticker == ticker, EarningsEvent.earnings_date > now)
        .order_by(EarningsEvent.earnings_date.asc())
        .first()
    )
    if not event:
        return None
    days = (event.earnings_date.replace(tzinfo=timezone.utc) - now).days
    return f"{event.earnings_date.strftime('%Y-%m-%d')} ({days} days away)"
