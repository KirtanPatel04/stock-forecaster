"""Log predictions and score them once the target time arrives."""
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import numpy as np
from sqlalchemy.orm import Session

from ..data.alpaca_client import get_latest_price
from ..data.data_manager import get_cached_bars
from ..forecasting.features import HORIZONS
from ..models.db_models import Prediction
from ..models.schemas import HorizonMetrics, ModelReportCard

logger = logging.getLogger(__name__)


def score_pending_predictions(db: Session, ticker: Optional[str] = None) -> int:
    """Score all predictions whose target_time has passed. Returns count scored."""
    now = datetime.now(timezone.utc)
    q = db.query(Prediction).filter(
        Prediction.target_time <= now,
        Prediction.scored_at.is_(None),
    )
    if ticker:
        q = q.filter(Prediction.ticker == ticker)

    pending = q.all()
    scored = 0
    for pred in pending:
        actual = _lookup_actual_price(db, pred.ticker, pred.target_time)
        if actual is None:
            continue
        actual_return = (actual - pred.price_at_prediction) / pred.price_at_prediction
        pred.actual_price = actual
        pred.actual_return = actual_return
        pred.scored_at = now
        pred.direction_correct = bool(np.sign(pred.predicted_return) == np.sign(actual_return))
        pred.in_50_band = bool(pred.lower_50 <= actual_return <= pred.upper_50)
        pred.in_80_band = bool(pred.lower_80 <= actual_return <= pred.upper_80)
        pred.error = abs(pred.predicted_return - actual_return)
        scored += 1

    if scored > 0:
        db.commit()
        logger.debug("Scored %d predictions", scored)

    return scored


def _lookup_actual_price(
    db: Session,
    ticker: str,
    target_time: datetime,
    tolerance_minutes: int = 5,
) -> Optional[float]:
    """Find the actual close price at or shortly after target_time from cached bars."""
    window_start = target_time - timedelta(minutes=tolerance_minutes)
    window_end = target_time + timedelta(minutes=tolerance_minutes)
    from ..models.db_models import PriceBar
    bar = (
        db.query(PriceBar)
        .filter(
            PriceBar.ticker == ticker,
            PriceBar.timestamp >= window_start,
            PriceBar.timestamp <= window_end,
            PriceBar.timeframe == "1Min",
        )
        .order_by(PriceBar.timestamp.asc())
        .first()
    )
    return float(bar.close) if bar else None


def compute_report_card(db: Session, ticker: Optional[str] = None) -> ModelReportCard:
    q = db.query(Prediction).filter(Prediction.scored_at.is_not(None))
    if ticker:
        q = q.filter(Prediction.ticker == ticker)
    predictions = q.all()

    if not predictions:
        return ModelReportCard(
            ticker=ticker,
            horizons=[],
            total_predictions=0,
            overall_directional_accuracy=0.0,
        )

    total = len(predictions)
    overall_dir = float(np.mean([p.direction_correct for p in predictions if p.direction_correct is not None])) if total else 0.0

    horizon_metrics = []
    for h in HORIZONS:
        h_preds = [p for p in predictions if p.horizon_minutes == h]
        if not h_preds:
            continue
        n = len(h_preds)
        dir_acc = float(np.mean([p.direction_correct for p in h_preds if p.direction_correct is not None]))
        mae = float(np.mean([p.error for p in h_preds if p.error is not None]))
        cov_80 = float(np.mean([p.in_80_band for p in h_preds if p.in_80_band is not None]))
        cov_50 = float(np.mean([p.in_50_band for p in h_preds if p.in_50_band is not None]))
        actuals = [p.actual_return for p in h_preds if p.actual_return is not None]
        naive_mae = float(np.mean(np.abs(actuals))) if actuals else 0.0

        horizon_metrics.append(HorizonMetrics(
            horizon_minutes=h,
            n_predictions=n,
            directional_accuracy=dir_acc,
            baseline_directional_accuracy=0.5,
            beats_baseline_direction=dir_acc > 0.5,
            mean_absolute_error=mae,
            baseline_mae=naive_mae,
            beats_baseline_mae=mae < naive_mae if naive_mae > 0 else False,
            band_50_coverage=cov_50,
            band_80_coverage=cov_80,
        ))

    return ModelReportCard(
        ticker=ticker,
        horizons=horizon_metrics,
        total_predictions=total,
        overall_directional_accuracy=overall_dir,
    )
