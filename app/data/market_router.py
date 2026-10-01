"""Routes market data calls to the right provider based on ticker format.

Tickers ending in .TO are Canadian (TSX) → served by yfinance.
All other tickers are US → served by Alpaca.
"""
from typing import Optional, List
import pandas as pd


def is_canadian(ticker: str) -> bool:
    return ticker.upper().endswith(".TO")


def get_bars(ticker: str, timeframe: str = "1Min", **kwargs) -> pd.DataFrame:
    if is_canadian(ticker):
        from .yfinance_client import get_bars as _get
        return _get(ticker, timeframe, **kwargs)
    from .alpaca_client import get_bars as _get
    return _get(ticker, timeframe, **kwargs)


def get_bars_multi(
    tickers: List[str],
    timeframe: str = "1Min",
    **kwargs,
) -> dict[str, pd.DataFrame]:
    canadian = [t for t in tickers if is_canadian(t)]
    us = [t for t in tickers if not is_canadian(t)]
    result: dict[str, pd.DataFrame] = {}
    if canadian:
        from .yfinance_client import get_bars_multi as _get
        result.update(_get(canadian, timeframe, **kwargs))
    if us:
        from .alpaca_client import get_bars_multi as _get
        result.update(_get(us, timeframe, **kwargs))
    return result


def get_latest_price(ticker: str) -> Optional[float]:
    if is_canadian(ticker):
        from .yfinance_client import get_latest_price as _get
        return _get(ticker)
    from .alpaca_client import get_latest_price as _get
    return _get(ticker)


def get_market_universe(top: int = 60) -> List[str]:
    from .yfinance_client import get_market_universe as _get
    return _get(top)


def get_market_movers() -> List[str]:
    from .yfinance_client import get_market_movers as _get
    return _get()


def get_market_movers_detail(top: int = 20) -> dict:
    from .yfinance_client import get_market_movers_detail as _get
    return _get(top)


async def get_stream(ticker: str):
    if is_canadian(ticker):
        from .yfinance_client import yfinance_stream
        return await yfinance_stream.subscribe(ticker)
    from .alpaca_client import alpaca_stream
    return await alpaca_stream.subscribe(ticker)


def unsubscribe_stream(ticker: str, q) -> None:
    if is_canadian(ticker):
        from .yfinance_client import yfinance_stream
        yfinance_stream.unsubscribe(ticker, q)
    else:
        from .alpaca_client import alpaca_stream
        alpaca_stream.unsubscribe(ticker, q)
