"""Finnhub client — news, earnings calendar, economic events, basic financials."""
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import List, Optional

import finnhub

from ..config import settings

logger = logging.getLogger(__name__)

_client: Optional[finnhub.Client] = None
_last_call_ts: float = 0.0
_throttle_lock = __import__("threading").Lock()
_RATE_LIMIT_DELAY = 0.5  # 30 calls/sec on free tier


def get_client() -> finnhub.Client:
    global _client
    if _client is None:
        _client = finnhub.Client(api_key=settings.finnhub_api_key)
    return _client


def _throttle():
    global _last_call_ts
    with _throttle_lock:
        elapsed = time.monotonic() - _last_call_ts
        if elapsed < _RATE_LIMIT_DELAY:
            time.sleep(_RATE_LIMIT_DELAY - elapsed)
        _last_call_ts = time.monotonic()


def get_company_news(ticker: str, days_back: int = 3) -> List[dict]:
    if not settings.finnhub_api_key:
        return []
    # Finnhub free tier uses bare tickers — strip .TO suffix for Canadian stocks
    fh_ticker = ticker.upper().removesuffix(".TO")
    _throttle()
    try:
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=days_back)
        news = get_client().company_news(
            fh_ticker,
            _from=start.strftime("%Y-%m-%d"),
            to=end.strftime("%Y-%m-%d"),
        )
        return news or []
    except Exception as e:
        logger.warning("finnhub company_news failed for %s: %s", fh_ticker, e)
        return []


def get_earnings_calendar(ticker: str, months_ahead: int = 3) -> List[dict]:
    if not settings.finnhub_api_key:
        return []
    fh_ticker = ticker.upper().removesuffix(".TO")
    _throttle()
    try:
        end = datetime.now(timezone.utc) + timedelta(days=months_ahead * 30)
        start = datetime.now(timezone.utc) - timedelta(days=7)
        data = get_client().earnings_calendar(
            _from=start.strftime("%Y-%m-%d"),
            to=end.strftime("%Y-%m-%d"),
            symbol=fh_ticker,
        )
        return data.get("earningsCalendar", []) if data else []
    except Exception as e:
        logger.warning("finnhub earnings_calendar failed for %s: %s", ticker, e)
        return []


def get_economic_calendar(months_ahead: int = 1) -> List[dict]:
    if not settings.finnhub_api_key:
        return []
    _throttle()
    try:
        data = get_client().economic_calendar()
        events = data.get("economicCalendar", []) if data else []
        cutoff = (datetime.now(timezone.utc) + timedelta(days=months_ahead * 30)).timestamp()
        now_ts = datetime.now(timezone.utc).timestamp()
        return [
            e for e in events
            if now_ts <= e.get("time", 0) <= cutoff
        ]
    except Exception as e:
        logger.warning("finnhub economic_calendar failed: %s", e)
        return []


def get_basic_financials(ticker: str) -> dict:
    if not settings.finnhub_api_key:
        return {}
    fh_ticker = ticker.upper().removesuffix(".TO")
    _throttle()
    try:
        return get_client().company_basic_financials(fh_ticker, "all") or {}
    except Exception as e:
        logger.warning("finnhub basic_financials failed for %s: %s", ticker, e)
        return {}


def get_recommendation_trends(ticker: str) -> List[dict]:
    if not settings.finnhub_api_key:
        return []
    fh_ticker = ticker.upper().removesuffix(".TO")
    _throttle()
    try:
        return get_client().recommendation_trends(fh_ticker) or []
    except Exception as e:
        logger.warning("finnhub recommendation_trends failed for %s: %s", ticker, e)
        return []


def get_option_chain_summary(ticker: str) -> dict:
    """Get implied volatility info from basic financials (52-week IV data)."""
    fin = get_basic_financials(ticker)
    metrics = fin.get("metric", {})
    return {
        "52WeekHigh": metrics.get("52WeekHigh"),
        "52WeekLow": metrics.get("52WeekLow"),
        "beta": metrics.get("beta"),
        "52WeekPriceReturnDaily": metrics.get("52WeekPriceReturnDaily"),
    }


def get_quote(ticker: str) -> Optional[dict]:
    """Return Finnhub real-time quote: {c, h, l, o, pc, t} or None on failure."""
    if not settings.finnhub_api_key:
        return None
    _throttle()
    try:
        data = get_client().quote(ticker)
        if data and data.get("c"):
            return data
        return None
    except Exception as e:
        logger.debug("finnhub quote failed for %s: %s", ticker, e)
        return None


def search_ticker(query: str) -> List[dict]:
    """Search for tickers. Returns TSX results first, then US. Each result has exchange and currency fields."""
    if not settings.finnhub_api_key:
        return []

    results: List[dict] = []
    seen: set[str] = set()

    def _search(q: str) -> None:
        _throttle()
        try:
            raw = get_client().symbol_lookup(q)
            items = raw.get("result", [])[:15] if raw else []
            for item in items:
                sym = (item.get("displaySymbol") or item.get("symbol") or "").strip()
                desc = item.get("description", "")
                exchange_raw = (item.get("exchange") or "").lower()
                is_ca = (
                    sym.upper().endswith(".TO")
                    or "toronto" in exchange_raw
                    or "tsx" in exchange_raw
                )
                if is_ca and not sym.upper().endswith(".TO"):
                    sym = sym + ".TO"
                sym = sym.upper()
                if sym in seen or not sym:
                    continue
                seen.add(sym)
                results.append({
                    "symbol": sym,
                    "description": desc,
                    "exchange": "TSX" if is_ca else "US",
                    "currency": "CAD" if is_ca else "USD",
                })
        except Exception as e:
            logger.warning("finnhub symbol_lookup failed for %s: %s", q, e)

    _search(query)
    if not query.upper().endswith(".TO"):
        _search(query + ".TO")

    canadian = [r for r in results if r["exchange"] == "TSX"]
    us = [r for r in results if r["exchange"] == "US"]
    return (canadian + us)[:10]
