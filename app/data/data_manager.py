"""Orchestrates all data sources and caches results in SQLite."""
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Optional

import pandas as pd
from sqlalchemy.orm import Session

from ..models.db_models import PriceBar, NewsItem, EarningsEvent, MacroEvent
from .market_router import get_bars, get_bars_multi
from .finnhub_client import get_company_news, get_earnings_calendar, get_economic_calendar
from .sec_edgar import get_recent_8k

logger = logging.getLogger(__name__)

CONTEXT_TICKERS = ["XIU.TO", "XIC.TO"]  # iShares TSX ETFs
SECTOR_ETFS = {
    "XFN.TO": "Financials", "XEG.TO": "Energy", "XIT.TO": "Technology",
    "XHC.TO": "Healthcare", "XMA.TO": "Materials", "XRE.TO": "RealEstate",
    "ZUT.TO": "Utilities", "XST.TO": "ConsumerStap", "XCD.TO": "ConsumerDisc",
}


def upsert_bars(db: Session, ticker: str, df: pd.DataFrame, timeframe: str = "1Min"):
    if df.empty:
        return
    # Bulk-fetch existing timestamps to avoid N select-then-insert races that create duplicates.
    ts_list = []
    for ts in df.index:
        ts_utc = ts.to_pydatetime() if hasattr(ts, "to_pydatetime") else ts
        if ts_utc.tzinfo is None:
            ts_utc = ts_utc.replace(tzinfo=timezone.utc)
        ts_list.append(ts_utc)

    existing_ts = set(
        r[0] for r in db.query(PriceBar.timestamp).filter(
            PriceBar.ticker == ticker,
            PriceBar.timeframe == timeframe,
            PriceBar.timestamp.in_(ts_list),
        ).all()
    )

    for ts_utc, (_, row) in zip(ts_list, df.iterrows()):
        if ts_utc in existing_ts:
            continue
        bar = PriceBar(
            ticker=ticker,
            timestamp=ts_utc,
            open=float(row["open"]),
            high=float(row["high"]),
            low=float(row["low"]),
            close=float(row["close"]),
            volume=float(row.get("volume", 0)),
            vwap=float(row["vwap"]) if "vwap" in row and pd.notna(row["vwap"]) else None,
            timeframe=timeframe,
        )
        db.add(bar)
        existing_ts.add(ts_utc)  # guard against duplicates within the same batch
    db.commit()


def fetch_and_cache_bars(
    db: Session,
    ticker: str,
    timeframe: str = "1Min",
    days_back: int = 5,
) -> pd.DataFrame:
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days_back)

    df = get_bars(ticker, timeframe=timeframe, start=start, end=end)
    if not df.empty:
        upsert_bars(db, ticker, df, timeframe)
    return df


def get_cached_bars(
    db: Session,
    ticker: str,
    timeframe: str = "1Min",
    limit: int = 500,
    start: Optional[datetime] = None,
) -> pd.DataFrame:
    q = db.query(PriceBar).filter(
        PriceBar.ticker == ticker,
        PriceBar.timeframe == timeframe,
    )
    if start:
        q = q.filter(PriceBar.timestamp >= start)
    bars = q.order_by(PriceBar.timestamp.desc()).limit(limit).all()
    if not bars:
        return pd.DataFrame()

    rows = [
        {
            "timestamp": b.timestamp,
            "open": b.open, "high": b.high, "low": b.low,
            "close": b.close, "volume": b.volume, "vwap": b.vwap,
        }
        for b in reversed(bars)
    ]
    df = pd.DataFrame(rows).set_index("timestamp")
    df.index = pd.to_datetime(df.index, utc=True)
    return df


def fetch_and_cache_news(db: Session, ticker: str, days_back: int = 3) -> List[NewsItem]:
    raw_news = get_company_news(ticker, days_back=days_back)
    items = []
    for n in raw_news:
        ext_id = str(n.get("id", "")) or n.get("url", "")
        if ext_id and db.query(NewsItem).filter(NewsItem.external_id == ext_id).first():
            continue
        pub_ts = n.get("datetime", 0)
        pub_dt = datetime.fromtimestamp(pub_ts, tz=timezone.utc) if pub_ts else datetime.now(timezone.utc)
        item = NewsItem(
            external_id=ext_id,
            ticker=ticker,
            source=n.get("source", "finnhub"),
            headline=n.get("headline", ""),
            summary=n.get("summary", ""),
            url=n.get("url", ""),
            published_at=pub_dt,
        )
        db.add(item)
        items.append(item)
    if items:
        db.commit()
    return items


def get_cached_news(
    db: Session,
    ticker: str,
    limit: int = 50,
    since: Optional[datetime] = None,
) -> List[NewsItem]:
    q = db.query(NewsItem).filter(NewsItem.ticker == ticker)
    if since:
        q = q.filter(NewsItem.published_at >= since)
    return q.order_by(NewsItem.published_at.desc()).limit(limit).all()


def fetch_context_bars(
    db: Session,
    timeframe: str = "1Min",
    days_back: int = 2,
) -> dict[str, pd.DataFrame]:
    """Fetch SPY, QQQ, and all sector ETFs for market context."""
    all_tickers = CONTEXT_TICKERS + list(SECTOR_ETFS.keys())
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days_back)
    result = get_bars_multi(all_tickers, timeframe=timeframe, start=start, end=end)
    for t, df in result.items():
        if not df.empty:
            upsert_bars(db, t, df, timeframe)
    return result


def days_to_next_earnings(db: Session, ticker: str) -> Optional[float]:
    now = datetime.now(timezone.utc)
    event = (
        db.query(EarningsEvent)
        .filter(EarningsEvent.ticker == ticker, EarningsEvent.earnings_date > now)
        .order_by(EarningsEvent.earnings_date.asc())
        .first()
    )
    if event:
        return (event.earnings_date.replace(tzinfo=timezone.utc) - now).total_seconds() / 86400
    return None


def sync_earnings_calendar(db: Session, ticker: str):
    events = get_earnings_calendar(ticker)
    for e in events:
        date_str = e.get("date", "")
        if not date_str:
            continue
        try:
            dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        existing = (
            db.query(EarningsEvent)
            .filter(EarningsEvent.ticker == ticker, EarningsEvent.earnings_date == dt)
            .first()
        )
        if not existing:
            ev = EarningsEvent(
                ticker=ticker,
                earnings_date=dt,
                eps_estimate=e.get("epsEstimate"),
                eps_actual=e.get("epsActual"),
                revenue_estimate=e.get("revenueEstimate"),
                revenue_actual=e.get("revenueActual"),
            )
            db.add(ev)
    db.commit()
