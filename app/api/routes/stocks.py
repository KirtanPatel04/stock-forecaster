"""Stock price data endpoints."""
import asyncio
import logging
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from ...database import get_db
from ...data.market_router import get_bars, get_latest_price, get_stream, unsubscribe_stream
from ...data.data_manager import fetch_and_cache_bars, get_cached_bars, upsert_bars
from ...data.finnhub_client import search_ticker
from ...models.db_models import PriceBar
from ...models.schemas import PriceBarOut
from ..websocket_manager import manager
from ...services.prediction_tracker import score_pending_predictions

router = APIRouter(prefix="/stocks", tags=["stocks"])
logger = logging.getLogger(__name__)


@router.get("/search")
def search(q: str = Query(..., min_length=1)):
    results = search_ticker(q)
    return results


@router.get("/forex/usdcad")
def get_usd_cad():
    from ...data.yfinance_client import get_usd_cad_rate
    rate = get_usd_cad_rate()
    if rate is None:
        raise HTTPException(status_code=503, detail="Forex rate unavailable")
    return {"rate": rate, "timestamp": datetime.now(timezone.utc).isoformat()}


@router.get("/{ticker}/bars", response_model=List[PriceBarOut])
def get_price_bars(
    ticker: str,
    timeframe: str = Query("1Min", regex="^(1Min|5Min|15Min|30Min|1Hour|1Day)$"),
    limit: int = Query(300, ge=1, le=2000),
    days_back: int = Query(5, ge=1, le=400),
    refresh: bool = Query(False),
    db: Session = Depends(get_db),
):
    ticker = ticker.upper()
    if refresh:
        try:
            fetch_and_cache_bars(db, ticker, timeframe=timeframe, days_back=days_back)
        except Exception as e:
            logger.warning("Could not refresh bars for %s: %s", ticker, e)

    df = get_cached_bars(db, ticker, timeframe=timeframe, limit=limit)
    if df.empty:
        try:
            df = fetch_and_cache_bars(db, ticker, timeframe=timeframe, days_back=days_back)
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"Could not fetch data: {e}")

    if df.empty:
        return []

    result = []
    for ts, row in df.iterrows():
        result.append(PriceBarOut(
            ticker=ticker,
            timestamp=ts,
            open=float(row["open"]),
            high=float(row["high"]),
            low=float(row["low"]),
            close=float(row["close"]),
            volume=float(row["volume"]),
            vwap=float(row["vwap"]) if "vwap" in row else None,
            timeframe=timeframe,
        ))
    return result


@router.get("/{ticker}/price")
def get_current_price(ticker: str):
    ticker = ticker.upper()
    price = get_latest_price(ticker)
    if price is None:
        raise HTTPException(status_code=404, detail="Price not available")
    return {"ticker": ticker, "price": price, "timestamp": datetime.now(timezone.utc).isoformat()}


@router.websocket("/ws/{ticker}")
async def websocket_stream(ws: WebSocket, ticker: str, db: Session = Depends(get_db)):
    """
    WebSocket stream for live price bars and forecast updates.
    Messages sent to client:
      {type: "bar",      data: PriceBarOut}
      {type: "forecast", data: ForecastResponse}
      {type: "news",     data: NewsItemOut}
    """
    ticker = ticker.upper()
    await manager.connect(ticker, ws)

    # Send initial historical bars
    df = get_cached_bars(db, ticker, timeframe="1Min", limit=300)
    if df.empty:
        try:
            df = fetch_and_cache_bars(db, ticker, timeframe="1Min", days_back=5)
        except Exception as e:
            logger.warning("Initial fetch failed for %s: %s", ticker, e)

    if not df.empty:
        bars = [
            {
                "ticker": ticker,
                "timestamp": ts.isoformat(),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["volume"]),
                "vwap": float(row["vwap"]) if "vwap" in row else None,
                "timeframe": "1Min",
            }
            for ts, row in df.iterrows()
        ]
        await ws.send_json({"type": "history", "data": bars})

    # Subscribe to the appropriate live stream (yfinance for .TO, Alpaca for US)
    bar_queue = await get_stream(ticker)

    try:
        while True:
            try:
                bar = await asyncio.wait_for(bar_queue.get(), timeout=30.0)
                import pandas as pd
                ts = datetime.fromisoformat(bar["timestamp"].replace("Z", "+00:00"))
                row = pd.Series({
                    "open": bar["open"], "high": bar["high"], "low": bar["low"],
                    "close": bar["close"], "volume": bar["volume"], "vwap": bar.get("vwap"),
                })
                df_new = pd.DataFrame([row], index=[ts])
                upsert_bars(db, ticker, df_new, "1Min")

                await ws.send_json({"type": "bar", "data": bar})
                score_pending_predictions(db, ticker)

            except asyncio.TimeoutError:
                await ws.send_json({"type": "ping"})
            except WebSocketDisconnect:
                break

    except WebSocketDisconnect:
        pass
    finally:
        unsubscribe_stream(ticker, bar_queue)
        manager.disconnect(ticker, ws)
