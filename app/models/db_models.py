from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, Text, JSON
from sqlalchemy.orm import mapped_column, Mapped
from typing import Optional
from datetime import datetime
from ..database import Base


class PriceBar(Base):
    __tablename__ = "price_bars"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    ticker: Mapped[str] = mapped_column(String, index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, index=True)
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float)
    vwap: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    timeframe: Mapped[str] = mapped_column(String, default="1Min")


class NewsItem(Base):
    __tablename__ = "news_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    external_id: Mapped[Optional[str]] = mapped_column(String, unique=True, nullable=True, index=True)
    ticker: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)
    source: Mapped[str] = mapped_column(String)
    headline: Mapped[str] = mapped_column(Text)
    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    url: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    published_at: Mapped[datetime] = mapped_column(DateTime, index=True)

    sentiment_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    relevance_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    surprise_level: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    expected_impact: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    sentiment_cached: Mapped[bool] = mapped_column(Boolean, default=False)


class Prediction(Base):
    __tablename__ = "predictions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    ticker: Mapped[str] = mapped_column(String, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    target_time: Mapped[datetime] = mapped_column(DateTime, index=True)
    horizon_minutes: Mapped[int] = mapped_column(Integer)

    price_at_prediction: Mapped[float] = mapped_column(Float)
    predicted_return: Mapped[float] = mapped_column(Float)
    lower_50: Mapped[float] = mapped_column(Float)
    upper_50: Mapped[float] = mapped_column(Float)
    lower_80: Mapped[float] = mapped_column(Float)
    upper_80: Mapped[float] = mapped_column(Float)

    actual_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    actual_return: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    scored_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    direction_correct: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    in_50_band: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    in_80_band: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    error: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    model_weights: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)


class AfterHoursReport(Base):
    __tablename__ = "afterhours_reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    ticker: Mapped[str] = mapped_column(String, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    report_date: Mapped[str] = mapped_column(String, index=True)

    lean: Mapped[str] = mapped_column(String)
    probability: Mapped[float] = mapped_column(Float)
    expected_low: Mapped[float] = mapped_column(Float)
    expected_high: Mapped[float] = mapped_column(Float)
    key_reasons: Mapped[list] = mapped_column(JSON)
    full_report: Mapped[dict] = mapped_column(JSON)

    actual_open: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    actual_direction_correct: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)


class EarningsEvent(Base):
    __tablename__ = "earnings_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    ticker: Mapped[str] = mapped_column(String, index=True)
    earnings_date: Mapped[datetime] = mapped_column(DateTime, index=True)
    eps_estimate: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    eps_actual: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    revenue_estimate: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    revenue_actual: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    surprise_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)


class MacroEvent(Base):
    __tablename__ = "macro_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    event_name: Mapped[str] = mapped_column(String)
    event_date: Mapped[datetime] = mapped_column(DateTime, index=True)
    country: Mapped[str] = mapped_column(String, default="US")
    impact: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    actual: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    estimate: Mapped[Optional[str]] = mapped_column(String, nullable=True)
