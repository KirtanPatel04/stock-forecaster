from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime


class PriceBarOut(BaseModel):
    ticker: str
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    vwap: Optional[float] = None
    timeframe: str = "1Min"

    model_config = {"from_attributes": True}


class NewsItemOut(BaseModel):
    id: int
    ticker: Optional[str] = None
    source: str
    headline: str
    summary: Optional[str] = None
    published_at: datetime
    sentiment_score: Optional[float] = None
    relevance_score: Optional[float] = None
    surprise_level: Optional[float] = None
    expected_impact: Optional[float] = None

    model_config = {"from_attributes": True}


class ForecastPoint(BaseModel):
    horizon_minutes: int
    target_time: datetime
    predicted_price: float
    lower_50: float
    upper_50: float
    lower_80: float
    upper_80: float


class ForecastResponse(BaseModel):
    ticker: str
    current_price: float
    forecast_points: List[ForecastPoint]
    exit_window_start: Optional[datetime] = None
    exit_window_end: Optional[datetime] = None
    model_weights: Dict[str, Any]
    computed_at: datetime
    buy_price: Optional[float] = None
    live_pnl: Optional[float] = None


class PredictionOut(BaseModel):
    id: int
    ticker: str
    created_at: datetime
    horizon_minutes: int
    predicted_return: float
    actual_return: Optional[float] = None
    direction_correct: Optional[bool] = None
    in_50_band: Optional[bool] = None
    in_80_band: Optional[bool] = None
    error: Optional[float] = None

    model_config = {"from_attributes": True}


class AfterHoursReportOut(BaseModel):
    ticker: str
    lean: str
    probability: float
    expected_low: float
    expected_high: float
    key_reasons: List[str]
    full_report: Dict[str, Any]

    model_config = {"from_attributes": True}


class HorizonMetrics(BaseModel):
    horizon_minutes: int
    n_predictions: int
    directional_accuracy: float
    baseline_directional_accuracy: float
    beats_baseline_direction: bool
    mean_absolute_error: float
    baseline_mae: float
    beats_baseline_mae: bool
    band_50_coverage: float
    band_80_coverage: float


class ModelReportCard(BaseModel):
    ticker: Optional[str] = None
    horizons: List[HorizonMetrics]
    total_predictions: int
    overall_directional_accuracy: float
    after_hours_accuracy: Optional[float] = None
    after_hours_n: Optional[int] = None


class BuyPriceRequest(BaseModel):
    ticker: str
    price: float
    timestamp: Optional[str] = None


class WSMessage(BaseModel):
    type: str
    data: Any
