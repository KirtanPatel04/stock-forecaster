"""Yahoo Finance client for Canadian TSX stocks (.TO suffix)."""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional, List

import pandas as pd
import yfinance as yf

logger = logging.getLogger(__name__)

# Top TSX stocks (bare symbols — .TO added internally)
TSX_UNIVERSE = [
    "RY", "TD", "BNS", "BMO", "CM", "NA",
    "SU", "CNQ", "CVE", "TOU", "ARX",
    "SHOP", "CSU", "OTEX", "BB",
    "BCE", "T",
    "ABX", "K", "FNV", "WPM", "AGI",
    "MFC", "SLF", "GWO", "IFC",
    "BAM", "BN", "CP", "CNR", "AC",
    "MRU", "L", "ATD", "GIB", "EMA",
    "ENB", "TRP", "PPL", "ALA",
    "WFG", "CCO", "NTR", "TIH",
    "QBR", "DOO", "MTY",
]

TIMEFRAME_MAP = {
    "1Min": "1m", "5Min": "5m", "15Min": "15m",
    "30Min": "30m", "1Hour": "1h", "1Day": "1d",
}


def _period_for(interval: str, delta_days: int) -> str:
    if interval == "1m":
        return f"{min(delta_days, 7)}d"
    if interval in ("5m", "15m", "30m"):
        return f"{min(delta_days, 60)}d"
    return f"{min(delta_days, 730)}d"


def _normalise_df(df: pd.DataFrame, end: Optional[datetime], limit: Optional[int]) -> pd.DataFrame:
    """Lowercase columns, ensure required cols, trim to end/limit."""
    if df.empty:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume", "vwap"])
    df = df.copy()
    df.columns = [c[0].lower() if isinstance(c, tuple) else c.lower() for c in df.columns]
    df.index = pd.to_datetime(df.index, utc=True)
    df = df.sort_index()
    for col in ["open", "high", "low", "close", "volume"]:
        if col not in df.columns:
            df[col] = float("nan")
    df["vwap"] = df["close"]
    if end:
        end_ts = pd.Timestamp(end)
        if end_ts.tzinfo is None:
            end_ts = end_ts.tz_localize("UTC")
        else:
            end_ts = end_ts.tz_convert("UTC")
        df = df[df.index <= end_ts]
    if limit:
        df = df.tail(limit)
    return df[["open", "high", "low", "close", "volume", "vwap"]]


def get_bars(
    ticker: str,
    timeframe: str = "1Min",
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    limit: int = 1000,
    **_,
) -> pd.DataFrame:
    interval = TIMEFRAME_MAP.get(timeframe, "1m")
    if start is None:
        start = datetime.now(timezone.utc) - timedelta(days=5)
    delta_days = max(1, (datetime.now(timezone.utc) - start).days + 1)
    period = _period_for(interval, delta_days)
    try:
        raw = yf.download(ticker, period=period, interval=interval, progress=False, auto_adjust=True)
        return _normalise_df(raw, end, limit)
    except Exception as e:
        logger.warning("yfinance get_bars failed for %s: %s", ticker, e)
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume", "vwap"])


def get_bars_multi(
    tickers: List[str],
    timeframe: str = "1Min",
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    limit: Optional[int] = 200,
    **_,
) -> dict[str, pd.DataFrame]:
    interval = TIMEFRAME_MAP.get(timeframe, "1m")
    if start is None:
        start = datetime.now(timezone.utc) - timedelta(days=2)
    delta_days = max(1, (datetime.now(timezone.utc) - start).days + 1)
    period = _period_for(interval, delta_days)
    result: dict[str, pd.DataFrame] = {}
    try:
        raw = yf.download(
            tickers, period=period, interval=interval,
            progress=False, auto_adjust=True, group_by="ticker",
        )
        for t in tickers:
            try:
                df = raw[t].copy() if len(tickers) > 1 else raw.copy()
                result[t] = _normalise_df(df, end, limit)
            except Exception:
                result[t] = pd.DataFrame()
    except Exception as e:
        logger.warning("yfinance get_bars_multi failed: %s", e)
        for t in tickers:
            result[t] = pd.DataFrame()
    return result


def get_latest_price(ticker: str) -> Optional[float]:
    try:
        info = yf.Ticker(ticker).fast_info
        price = getattr(info, "last_price", None) or getattr(info, "regular_market_price", None)
        if price and float(price) > 0:
            return float(price)
        df = get_bars(ticker, timeframe="1Day", limit=1)
        if not df.empty:
            return float(df["close"].iloc[-1])
    except Exception as e:
        logger.warning("yfinance get_latest_price failed for %s: %s", ticker, e)
    return None


def get_market_universe(top: int = 60) -> List[str]:
    return [f"{t}.TO" for t in TSX_UNIVERSE[:top]]


def get_market_movers_detail(top: int = 20) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {"gainers": [], "losers": []}
    tickers = [f"{t}.TO" for t in TSX_UNIVERSE[:40]]
    try:
        raw = yf.download(
            tickers, period="2d", interval="1d",
            progress=False, auto_adjust=True, group_by="ticker",
        )
        movers = []
        for t in tickers:
            try:
                df = raw[t].copy() if len(tickers) > 1 else raw.copy()
                df.columns = [c[0].lower() if isinstance(c, tuple) else c.lower() for c in df.columns]
                if len(df) < 2:
                    continue
                prev = float(df["close"].iloc[-2])
                curr = float(df["close"].iloc[-1])
                if prev <= 0:
                    continue
                pct = (curr - prev) / prev * 100
                movers.append({"symbol": t, "price": round(curr, 2), "change": round(curr - prev, 2), "percent_change": round(pct, 2)})
            except Exception:
                continue
        movers.sort(key=lambda x: x["percent_change"], reverse=True)
        half = max(1, top // 2)
        out["gainers"] = movers[:half]
        out["losers"] = sorted(movers, key=lambda x: x["percent_change"])[:half]
    except Exception as e:
        logger.warning("yfinance get_market_movers_detail failed: %s", e)
    return out


def get_market_movers() -> List[str]:
    detail = get_market_movers_detail(top=20)
    return [m["symbol"] for m in detail["gainers"] + detail["losers"]]


def get_usd_cad_rate() -> Optional[float]:
    """Return current USD/CAD rate (CAD per 1 USD)."""
    try:
        info = yf.Ticker("USDCAD=X").fast_info
        rate = getattr(info, "last_price", None) or getattr(info, "regular_market_price", None)
        if rate and float(rate) > 0:
            return float(rate)
        raw = yf.download("USDCAD=X", period="1d", interval="5m", progress=False, auto_adjust=True)
        if not raw.empty:
            raw.columns = [c[0].lower() if isinstance(c, tuple) else c.lower() for c in raw.columns]
            return float(raw["close"].iloc[-1])
    except Exception as e:
        logger.warning("get_usd_cad_rate failed: %s", e)
    return None


class YFinanceStream:
    """Polls yfinance every 30s and pushes new 1-min bars to per-ticker queues."""

    def __init__(self):
        self._queues: dict[str, list[asyncio.Queue]] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    async def subscribe(self, ticker: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        self._queues.setdefault(ticker, []).append(q)
        if ticker not in self._tasks or self._tasks[ticker].done():
            self._tasks[ticker] = asyncio.create_task(self._poll(ticker))
        return q

    def unsubscribe(self, ticker: str, q: asyncio.Queue):
        queues = self._queues.get(ticker, [])
        if q in queues:
            queues.remove(q)
        if not queues and ticker in self._tasks:
            self._tasks[ticker].cancel()
            self._tasks.pop(ticker, None)

    async def _poll(self, ticker: str):
        last_ts = None
        while self._queues.get(ticker):
            try:
                await asyncio.sleep(30)

                def _fetch():
                    raw = yf.download(ticker, period="1d", interval="1m", progress=False, auto_adjust=True)
                    return raw

                raw = await asyncio.to_thread(_fetch)
                if raw.empty:
                    continue
                raw.columns = [c[0].lower() if isinstance(c, tuple) else c.lower() for c in raw.columns]
                raw.index = pd.to_datetime(raw.index, utc=True)
                ts = raw.index[-1]
                if last_ts is not None and ts == last_ts:
                    continue
                last_ts = ts
                latest = raw.iloc[-1]
                bar = {
                    "ticker": ticker,
                    "timestamp": ts.isoformat(),
                    "open": float(latest["open"]),
                    "high": float(latest["high"]),
                    "low": float(latest["low"]),
                    "close": float(latest["close"]),
                    "volume": float(latest.get("volume", 0)),
                    "vwap": float(latest["close"]),
                }
                for q in list(self._queues.get(ticker, [])):
                    await q.put(bar)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.debug("YFinanceStream poll error for %s: %s", ticker, e)


yfinance_stream = YFinanceStream()
