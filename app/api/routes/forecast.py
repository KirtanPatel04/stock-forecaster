"""Forecast endpoints — train model and generate predictions."""
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ...database import get_db
from ...data.data_manager import (
    fetch_and_cache_bars,
    fetch_context_bars,
    get_cached_bars,
    get_cached_news,
    days_to_next_earnings,
    sync_earnings_calendar,
)
from ...forecasting.ensemble import get_ensemble
from ...forecasting.features import HORIZONS
from ...models.db_models import Prediction
from ...models.schemas import BuyPriceRequest, ForecastPoint, ForecastResponse

router = APIRouter(prefix="/forecast", tags=["forecast"])
logger = logging.getLogger(__name__)

_buy_prices: dict[str, float] = {}


@router.post("/{ticker}/train")
def train_model(
    ticker: str,
    days_back: int = Query(30, ge=7, le=90),
    db: Session = Depends(get_db),
):
    ticker = ticker.upper()
    try:
        fetch_and_cache_bars(db, ticker, timeframe="1Min", days_back=days_back)
        sync_earnings_calendar(db, ticker)
    except Exception as e:
        logger.warning("Data fetch for training failed: %s", e)

    df = get_cached_bars(db, ticker, timeframe="1Min", limit=days_back * 390)
    if len(df) < 200:
        raise HTTPException(status_code=400, detail=f"Not enough bars for training ({len(df)} < 200)")

    try:
        context = fetch_context_bars(db, timeframe="1Min", days_back=days_back)
    except Exception:
        context = {}

    news_sentiment = _build_news_sentiment(db, ticker, df.index)
    d_to_earnings = days_to_next_earnings(db, ticker)

    ensemble = get_ensemble(ticker)
    trained = ensemble.fit(df, context=context, news_sentiment=news_sentiment, days_to_earnings=d_to_earnings)
    if not trained:
        raise HTTPException(status_code=500, detail="Model training failed — not enough data")

    return {"ticker": ticker, "status": "trained", "bars_used": len(df)}


@router.get("/{ticker}", response_model=ForecastResponse)
def get_forecast(
    ticker: str,
    save: bool = Query(True),
    db: Session = Depends(get_db),
):
    ticker = ticker.upper()
    df = get_cached_bars(db, ticker, timeframe="1Min", limit=500)
    if df.empty or len(df) < 30:
        raise HTTPException(status_code=404, detail="No price data; run /train first")

    try:
        context = _get_context(db)
    except Exception:
        context = {}

    news_sentiment = _build_news_sentiment(db, ticker, df.index)
    d_to_earnings = days_to_next_earnings(db, ticker)
    current_price = float(df["close"].iloc[-1])
    now = datetime.now(timezone.utc)

    ensemble = get_ensemble(ticker)
    result = ensemble.predict(
        df,
        context=context,
        news_sentiment=news_sentiment,
        days_to_earnings=d_to_earnings,
        current_price=current_price,
    )

    forecast_points = []
    model_weights_flat = {}
    exit_window_start = None
    exit_window_end = None
    best_upside = -999.0
    buy_price = _buy_prices.get(ticker)

    for h, pred in result["horizons"].items():
        target_time = now + timedelta(minutes=h)
        predicted_return = pred["predicted_return"]
        predicted_price = current_price * (1 + predicted_return)
        lower_50 = current_price * (1 + pred["lower_50"])
        upper_50 = current_price * (1 + pred["upper_50"])
        lower_80 = current_price * (1 + pred["lower_80"])
        upper_80 = current_price * (1 + pred["upper_80"])

        fp = ForecastPoint(
            horizon_minutes=h,
            target_time=target_time,
            predicted_price=predicted_price,
            lower_50=lower_50,
            upper_50=upper_50,
            lower_80=lower_80,
            upper_80=upper_80,
        )
        forecast_points.append(fp)

        # Exit window: max upside vs downside asymmetry
        if buy_price:
            upside = (upper_50 - buy_price) / buy_price
            downside = (buy_price - lower_50) / buy_price
            net = upside - downside
            if net > best_upside:
                best_upside = net
                exit_window_start = target_time - timedelta(minutes=h // 4)
                exit_window_end = target_time

        model_weights_flat[str(h)] = pred.get("weights", {})

        if save:
            _save_prediction(db, ticker, h, current_price, pred, target_time)

    forecast_points.sort(key=lambda x: x.horizon_minutes)
    pnl = None
    if buy_price:
        pnl = (current_price - buy_price) / buy_price * 100

    return ForecastResponse(
        ticker=ticker,
        current_price=current_price,
        forecast_points=forecast_points,
        exit_window_start=exit_window_start,
        exit_window_end=exit_window_end,
        model_weights={str(k): str(v) for k, v in model_weights_flat.items()},
        computed_at=now,
        buy_price=buy_price,
        live_pnl=pnl,
    )


@router.post("/buy-price")
def set_buy_price(req: BuyPriceRequest):
    _buy_prices[req.ticker.upper()] = req.price
    return {"status": "ok", "ticker": req.ticker.upper(), "buy_price": req.price}


@router.delete("/{ticker}/buy-price")
def clear_buy_price(ticker: str):
    _buy_prices.pop(ticker.upper(), None)
    return {"status": "cleared"}


def _build_news_sentiment(db: Session, ticker: str, index: pd.DatetimeIndex) -> pd.Series:
    """Build a sentiment time series aligned to price bar index."""
    since = index.min() if len(index) > 0 else None
    news = get_cached_news(db, ticker, limit=200, since=since)
    if not news:
        return pd.Series(dtype=float)

    ts_list = []
    for n in news:
        if n.sentiment_cached and n.sentiment_score is not None:
            ts_list.append((n.published_at, n.sentiment_score))

    if not ts_list:
        return pd.Series(dtype=float)

    s = pd.Series(dict(ts_list)).sort_index()
    s.index = pd.to_datetime(s.index, utc=True)
    return s


def _get_context(db: Session) -> dict:
    from ...data.data_manager import CONTEXT_TICKERS, SECTOR_ETFS, get_cached_bars
    ctx = {}
    for t in CONTEXT_TICKERS + list(SECTOR_ETFS.keys()):
        df = get_cached_bars(db, t, timeframe="1Min", limit=500)
        if not df.empty:
            ctx[t] = df
    return ctx


def _save_prediction(
    db: Session,
    ticker: str,
    horizon: int,
    current_price: float,
    pred: dict,
    target_time: datetime,
):
    try:
        p = Prediction(
            ticker=ticker,
            target_time=target_time,
            horizon_minutes=horizon,
            price_at_prediction=current_price,
            predicted_return=pred["predicted_return"],
            lower_50=pred["lower_50"],
            upper_50=pred["upper_50"],
            lower_80=pred["lower_80"],
            upper_80=pred["upper_80"],
            model_weights=pred.get("weights"),
        )
        db.add(p)
        db.commit()
    except Exception as e:
        logger.debug("Could not save prediction: %s", e)
        db.rollback()
