"""Alpaca Markets data client — historical bars, live streaming, extended hours."""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import AsyncGenerator, Callable, List, Optional

import pandas as pd
from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.historical.screener import ScreenerClient
from alpaca.data.requests import (
    StockBarsRequest, StockLatestBarRequest, StockLatestQuoteRequest,
    MostActivesRequest, MarketMoversRequest,
)
from alpaca.data.timeframe import TimeFrame, TimeFrameUnit
from alpaca.data.live import StockDataStream
from alpaca.data.enums import DataFeed, Adjustment

from ..config import settings

logger = logging.getLogger(__name__)

_hist_client: Optional[StockHistoricalDataClient] = None
_screener_client: Optional[ScreenerClient] = None
_stream: Optional[StockDataStream] = None


def get_hist_client() -> StockHistoricalDataClient:
    global _hist_client
    if _hist_client is None:
        _hist_client = StockHistoricalDataClient(
            api_key=settings.alpaca_api_key,
            secret_key=settings.alpaca_secret_key,
        )
    return _hist_client


def get_screener_client() -> ScreenerClient:
    global _screener_client
    if _screener_client is None:
        _screener_client = ScreenerClient(
            api_key=settings.alpaca_api_key,
            secret_key=settings.alpaca_secret_key,
        )
    return _screener_client


def get_market_universe(top: int = 100) -> List[str]:
    """Return today's most-active tickers from Alpaca's screener.

    Falls back to an empty list on error — callers should supply their own
    fallback universe if needed.
    """
    try:
        client = get_screener_client()
        req = MostActivesRequest(top=top, by="volume")
        result = client.get_most_actives(req)
        if hasattr(result, "most_actives"):
            return [item.symbol for item in result.most_actives if item.symbol]
        if isinstance(result, dict):
            return [item.get("symbol") for item in result.get("most_actives", []) if item.get("symbol")]
    except Exception as e:
        logger.warning("get_market_universe failed: %s", e)
    return []


def get_market_movers_detail(top: int = 20) -> dict[str, list[dict]]:
    """Return today's top gainers and losers with price, $ change and % change.

    Shape: {"gainers": [{symbol, price, change, percent_change}, ...], "losers": [...]}
    """
    out: dict[str, list[dict]] = {"gainers": [], "losers": []}
    try:
        client = get_screener_client()
        result = client.get_market_movers(MarketMoversRequest(top=top))
        for attr in ("gainers", "losers"):
            items = getattr(result, attr, None) or (result.get(attr) if isinstance(result, dict) else [])
            for i in items or []:
                get = (lambda k: i.get(k)) if isinstance(i, dict) else (lambda k: getattr(i, k, None))
                if not get("symbol"):
                    continue
                out[attr].append({
                    "symbol": get("symbol"),
                    "price": float(get("price") or 0),
                    "change": float(get("change") or 0),
                    "percent_change": float(get("percent_change") or 0),
                })
    except Exception as e:
        logger.warning("get_market_movers_detail failed: %s", e)
    return out


def get_market_movers() -> List[str]:
    """Return today's top gainers + losers — these carry the most momentum."""
    detail = get_market_movers_detail(top=20)
    return [m["symbol"] for m in detail["gainers"] + detail["losers"]]


def _timeframe_from_str(tf: str) -> TimeFrame:
    mapping = {
        "1Min": TimeFrame(1, TimeFrameUnit.Minute),
        "5Min": TimeFrame(5, TimeFrameUnit.Minute),
        "15Min": TimeFrame(15, TimeFrameUnit.Minute),
        "30Min": TimeFrame(30, TimeFrameUnit.Minute),
        "1Hour": TimeFrame(1, TimeFrameUnit.Hour),
        "1Day": TimeFrame(1, TimeFrameUnit.Day),
    }
    return mapping.get(tf, TimeFrame(1, TimeFrameUnit.Minute))


def get_bars(
    ticker: str,
    timeframe: str = "1Min",
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    limit: int = 1000,
    feed: str = "iex",
    extended_hours: bool = True,
) -> pd.DataFrame:
    client = get_hist_client()
    if start is None:
        start = datetime.now(timezone.utc) - timedelta(days=5)
    if end is None:
        end = datetime.now(timezone.utc)

    data_feed = DataFeed.IEX if feed == "iex" else DataFeed.SIP

    request = StockBarsRequest(
        symbol_or_symbols=ticker,
        timeframe=_timeframe_from_str(timeframe),
        start=start,
        end=end,
        limit=limit,
        feed=data_feed,
        adjustment=Adjustment.RAW,
    )
    bars = client.get_stock_bars(request)
    df = bars.df
    if df.empty:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume", "vwap"])

    if isinstance(df.index, pd.MultiIndex):
        df = df.xs(ticker, level=0)

    df.index = pd.to_datetime(df.index, utc=True)
    df = df.rename(columns=str.lower)
    for col in ["open", "high", "low", "close", "volume"]:
        if col not in df.columns:
            df[col] = float("nan")
    if "vwap" not in df.columns:
        df["vwap"] = df["close"]
    return df[["open", "high", "low", "close", "volume", "vwap"]]


def get_latest_price(ticker: str) -> Optional[float]:
    """Return the most current price available — validated against Finnhub NBBO."""
    from .finnhub_client import get_quote as _fh_quote

    try:
        client = get_hist_client()

        # Finnhub real-time quote is the most reliable anchor (NBBO, not IEX-only)
        fh_price: Optional[float] = None
        fh_high: Optional[float] = None
        fh_low: Optional[float] = None
        try:
            fh = _fh_quote(ticker)
            if fh:
                fh_price = float(fh["c"])
                fh_high = float(fh.get("h") or 0) or None
                fh_low = float(fh.get("l") or 0) or None
        except Exception:
            pass

        # IEX bar close — always reliable for liquid stocks
        bar_price: Optional[float] = None
        try:
            bar_req = StockLatestBarRequest(symbol_or_symbols=ticker, feed=DataFeed.IEX)
            bar_result = client.get_stock_latest_bar(bar_req)
            bar = bar_result.get(ticker)
            if bar:
                bar_price = float(bar.close)
        except Exception:
            pass

        # If Finnhub gave us a price, prefer it — it reflects the real NBBO
        if fh_price and fh_price >= 0.50:
            return fh_price

        # Try the IEX quote mid, but validate it against Finnhub or bar close
        try:
            req = StockLatestQuoteRequest(symbol_or_symbols=ticker, feed=DataFeed.IEX)
            result = client.get_stock_latest_quote(req)
            quote = result.get(ticker)
            if quote:
                ask = getattr(quote, "ask_price", None) or 0.0
                bid = getattr(quote, "bid_price", None) or 0.0
                MIN_SANE_PRICE = 0.50
                mid: Optional[float] = None
                if ask >= MIN_SANE_PRICE and bid >= MIN_SANE_PRICE:
                    mid = float((ask + bid) / 2)
                elif ask >= MIN_SANE_PRICE:
                    mid = float(ask)
                elif bid >= MIN_SANE_PRICE:
                    mid = float(bid)

                if mid is not None:
                    anchor = bar_price
                    # Reject if outside today's intraday range (Finnhub)
                    if fh_high and mid > fh_high * 1.02:
                        mid = None
                    elif fh_low and mid < fh_low * 0.98:
                        mid = None
                    # Also reject if >10% from the bar close
                    elif anchor and abs(mid - anchor) / anchor >= 0.10:
                        mid = None

                if mid is not None:
                    return mid
        except Exception as qe:
            logger.debug("Quote fetch failed for %s: %s", ticker, qe)

        return bar_price
    except Exception as e:
        logger.warning("get_latest_price failed for %s: %s", ticker, e)
        return None


def get_bars_multi(
    tickers: List[str],
    timeframe: str = "1Min",
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    limit: Optional[int] = 200,
) -> dict[str, pd.DataFrame]:
    """Fetch bars for multiple tickers (e.g. SPY, QQQ, sector ETFs)."""
    client = get_hist_client()
    if start is None:
        start = datetime.now(timezone.utc) - timedelta(days=2)
    if end is None:
        end = datetime.now(timezone.utc)

    request = StockBarsRequest(
        symbol_or_symbols=tickers,
        timeframe=_timeframe_from_str(timeframe),
        start=start,
        end=end,
        limit=limit,
        feed=DataFeed.IEX,
        adjustment=Adjustment.RAW,
    )
    bars = client.get_stock_bars(request)
    df_all = bars.df
    result = {}
    for t in tickers:
        try:
            df = df_all.xs(t, level=0) if isinstance(df_all.index, pd.MultiIndex) else df_all
            df.index = pd.to_datetime(df.index, utc=True)
            df = df.rename(columns=str.lower)
            result[t] = df[["open", "high", "low", "close", "volume"]]
        except (KeyError, Exception) as e:
            logger.debug("No data for %s: %s", t, e)
            result[t] = pd.DataFrame()
    return result


class AlpacaStream:
    """Wraps StockDataStream and relays bars via an asyncio.Queue."""

    def __init__(self):
        self._stream: Optional[StockDataStream] = None
        self._queues: dict[str, list[asyncio.Queue]] = {}
        self._subscribed: set[str] = set()
        self._task: Optional[asyncio.Task] = None

    def _get_stream(self) -> StockDataStream:
        if self._stream is None:
            self._stream = StockDataStream(
                api_key=settings.alpaca_api_key,
                secret_key=settings.alpaca_secret_key,
                feed=DataFeed.IEX,
            )
        return self._stream

    async def _bar_handler(self, bar):
        ticker = bar.symbol
        bar_dict = {
            "ticker": ticker,
            "timestamp": bar.timestamp.isoformat(),
            "open": float(bar.open),
            "high": float(bar.high),
            "low": float(bar.low),
            "close": float(bar.close),
            "volume": float(bar.volume),
            "vwap": float(bar.vwap) if bar.vwap else float(bar.close),
        }
        for q in self._queues.get(ticker, []):
            await q.put(bar_dict)

    async def subscribe(self, ticker: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        self._queues.setdefault(ticker, []).append(q)

        if ticker not in self._subscribed:
            stream = self._get_stream()
            stream.subscribe_bars(self._bar_handler, ticker)
            self._subscribed.add(ticker)
            if self._task is None or self._task.done():
                self._task = asyncio.create_task(self._run())
        return q

    async def _run(self):
        try:
            self._get_stream().run()
        except Exception as e:
            logger.error("Alpaca stream error: %s", e)

    def unsubscribe(self, ticker: str, q: asyncio.Queue):
        queues = self._queues.get(ticker, [])
        if q in queues:
            queues.remove(q)


alpaca_stream = AlpacaStream()
