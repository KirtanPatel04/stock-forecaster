"""Top picks for tomorrow's open — screens a universe of tickers for bullish after-hours news."""
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ...database import get_db
from ...services.movers_scanner import scan_top_picks, scan_intraday_picks
from ...data.alpaca_client import get_market_movers_detail

router = APIRouter(prefix="/movers", tags=["movers"])
logger = logging.getLogger(__name__)


@router.get("/top-picks")
def get_top_picks(
    limit: int = Query(8, ge=1, le=20),
    tickers: Optional[str] = Query(None, description="Comma-separated extra tickers to include (e.g. watchlist)"),
    max_price: Optional[float] = Query(None, description="Exclude stocks above this price (user's cash balance)"),
    db: Session = Depends(get_db),
):
    extra = [t.strip().upper() for t in tickers.split(",") if t.strip()] if tickers else []
    try:
        picks = scan_top_picks(db, extra_tickers=extra, limit=limit, max_price=max_price)
        return {
            "picks": picks,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        logger.exception("Top picks scan failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/intraday-picks")
def get_intraday_picks(
    limit: int = Query(8, ge=1, le=20),
    tickers: Optional[str] = Query(None),
    max_price: Optional[float] = Query(None, description="Exclude stocks above this price (user's cash balance)"),
    db: Session = Depends(get_db),
):
    """Live intraday momentum scan — stocks most likely to move UP in the next 1-2 hours."""
    extra = [t.strip().upper() for t in tickers.split(",") if t.strip()] if tickers else []
    try:
        picks = scan_intraday_picks(db, extra_tickers=extra, limit=limit, max_price=max_price)
        now = datetime.now(timezone.utc)
        # TSX/NYSE market hours: 13:30–20:00 UTC summer / 14:30–21:00 UTC winter (Mon–Fri)
        market_open = (
            now.weekday() < 5
            and timedelta(hours=13, minutes=30) <= timedelta(hours=now.hour, minutes=now.minute) <= timedelta(hours=20)
        )
        return {
            "picks": picks,
            "generated_at": now.isoformat(),
            "market_open": market_open,
        }
    except Exception as e:
        logger.exception("Intraday picks scan failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/biggest")
def get_biggest_movers(
    limit: int = Query(10, ge=1, le=50),
    min_price: float = Query(1.0, ge=0, description="Hide sub-$X stocks (penny stocks, warrants)"),
):
    """Today's top % gainers and losers across the whole market."""
    # Over-fetch, since the price / warrant filter can drop a lot of the list
    detail = get_market_movers_detail(top=50)

    def _keep(m: dict) -> bool:
        sym = m["symbol"]
        # Warrants (…W, …WS) and units (…U) dominate raw movers lists but aren't ordinary shares
        is_derivative = len(sym) >= 5 and sym[-1] in ("W", "U") or sym.endswith(".WS")
        return m["price"] >= min_price and not is_derivative

    return {
        "gainers": [m for m in detail["gainers"] if _keep(m)][:limit],
        "losers": [m for m in detail["losers"] if _keep(m)][:limit],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
