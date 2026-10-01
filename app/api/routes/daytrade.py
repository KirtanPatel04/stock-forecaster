"""Day Trade — Ross Cameron Five-Pillars scanner, pullback setups and market rail."""
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from ...services.daytrade_scanner import scan, evaluate_symbol, get_intraday_bars, live_setups, market_overview
from ...services.next_day import build_watchlist, get_daily_bars

router = APIRouter(prefix="/daytrade", tags=["daytrade"])
logger = logging.getLogger(__name__)


@router.get("/scan")
def get_scan(limit: int = Query(25, ge=1, le=50)):
    try:
        return scan(limit=limit)
    except Exception as e:
        logger.exception("Day-trade scan failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/stock/{symbol}")
def get_stock(symbol: str):
    result = evaluate_symbol(symbol)
    if result is None:
        raise HTTPException(status_code=404, detail=f"No US equity data for {symbol.upper()}")
    return result


@router.get("/bars/{symbol}")
def get_bars(symbol: str):
    return get_intraday_bars(symbol.upper())


@router.get("/live")
def get_live(symbols: str = Query(..., description="Comma-separated symbols (max 40)")):
    """Live price + setup (entry / stop / 2:1 target) for each symbol, refreshed every ~5s."""
    return live_setups(symbols.split(","))


@router.get("/market")
def get_market():
    try:
        return market_overview()
    except Exception as e:
        logger.exception("Market overview failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/watchlist")
def get_watchlist(
    tickers: Optional[str] = Query(None, description="Comma-separated pinned symbols to always include"),
    limit: int = Query(30, ge=1, le=60),
):
    """Next-day watchlist — after-hours movers and pre-market gappers, checked Ross's way."""
    extra = [t.strip().upper() for t in tickers.split(",") if t.strip()] if tickers else []
    try:
        return build_watchlist(extra=extra, limit=limit)
    except Exception as e:
        logger.exception("Watchlist build failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/daily/{symbol}")
def get_daily(symbol: str):
    return get_daily_bars(symbol.upper())
