"""Leak-proof feature engineering for the forecasting models.

INVARIANT: every feature at index i uses only data from rows 0..i-1 (shifted by 1)
so that features are always available at prediction time without lookahead.
"""
import numpy as np
import pandas as pd
from typing import Optional


HORIZONS = [15, 30, 60, 120, 390]  # minutes: 15, 30, 1hr, 2hr, end-of-day proxy


def _safe_rsi(series: pd.Series, window: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(window).mean()
    loss = (-delta.clip(upper=0)).rolling(window).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _macd(series: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    ema_fast = series.ewm(span=fast, adjust=False).mean()
    ema_slow = series.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    return macd_line, signal_line


def build_features(
    df: pd.DataFrame,
    context: Optional[dict[str, pd.DataFrame]] = None,
    news_sentiment: Optional[pd.Series] = None,
    days_to_earnings: Optional[float] = None,
    implied_vol: Optional[float] = None,
) -> pd.DataFrame:
    """
    Build a feature matrix from OHLCV bars.

    df: DataFrame with columns [open, high, low, close, volume, vwap]
        indexed by UTC datetime (1-minute bars).
    context: dict ticker -> DataFrame for SPY, QQQ, sector ETFs (same index).
    news_sentiment: Series indexed by datetime of aggregated sentiment score up to that bar.
    days_to_earnings: float, days until next earnings (constant for a session).
    implied_vol: float from option chain (constant for a session).

    Returns feature DataFrame aligned with df, with NaN rows at the start.
    """
    if df.empty or len(df) < 30:
        return pd.DataFrame()

    close = df["close"]
    volume = df["volume"]
    high = df["high"]
    low = df["low"]
    vwap = df.get("vwap", close)

    feats = pd.DataFrame(index=df.index)

    # Returns at multiple lookbacks — shifted so no lookahead
    for lb in [1, 5, 10, 15, 30, 60]:
        feats[f"ret_{lb}"] = close.pct_change(lb).shift(1)

    # Realized volatility (std of returns)
    for win in [5, 15, 30]:
        feats[f"vol_{win}"] = close.pct_change().shift(1).rolling(win).std()

    # Volume ratio vs rolling mean
    for win in [10, 30]:
        avg_vol = volume.shift(1).rolling(win).mean()
        feats[f"vol_ratio_{win}"] = (volume.shift(1) / avg_vol.replace(0, np.nan)).fillna(1.0)

    # VWAP distance
    feats["vwap_dist"] = ((close.shift(1) - vwap.shift(1)) / close.shift(1).replace(0, np.nan))

    # RSI
    feats["rsi_14"] = _safe_rsi(close, 14).shift(1)
    feats["rsi_7"] = _safe_rsi(close, 7).shift(1)

    # MACD
    macd_line, signal_line = _macd(close)
    feats["macd"] = macd_line.shift(1)
    feats["macd_signal"] = signal_line.shift(1)
    feats["macd_hist"] = (macd_line - signal_line).shift(1)

    # Price position within recent range
    roll_high = high.shift(1).rolling(30).max()
    roll_low = low.shift(1).rolling(30).min()
    feats["price_position"] = (close.shift(1) - roll_low) / (roll_high - roll_low + 1e-9)

    # Average true range
    tr = pd.concat([
        high - low,
        (high - close.shift(1)).abs(),
        (low - close.shift(1)).abs(),
    ], axis=1).max(axis=1)
    feats["atr_14"] = tr.shift(1).rolling(14).mean() / close.shift(1).replace(0, np.nan)

    # Time features (no lookahead — time of the *current* bar is known)
    feats["minute_of_day"] = df.index.hour * 60 + df.index.minute
    feats["day_of_week"] = df.index.dayofweek
    # Encode time of day as sine/cosine (market opens 9:30 = 570 min from midnight)
    market_min = feats["minute_of_day"]
    feats["time_sin"] = np.sin(2 * np.pi * market_min / 390)
    feats["time_cos"] = np.cos(2 * np.pi * market_min / 390)
    for d in range(5):
        feats[f"dow_{d}"] = (feats["day_of_week"] == d).astype(float)

    # Context: SPY, QQQ, sector ETFs
    if context:
        for ticker, ctx_df in context.items():
            if ctx_df.empty:
                continue
            ctx_close = ctx_df["close"].reindex(df.index, method="ffill")
            for lb in [1, 5, 15]:
                feats[f"{ticker.lower()}_ret_{lb}"] = ctx_close.pct_change(lb).shift(1)

    # News sentiment: aggregate sentiment score for news published up to this bar
    if news_sentiment is not None and not news_sentiment.empty:
        # Reindex to bar timestamps, forward-fill, then shift(1) so news published at
        # bar T is only visible starting at bar T+1 (no same-bar leakage).
        aligned = news_sentiment.reindex(df.index, method="ffill").fillna(0.0)
        feats["news_sentiment"] = aligned.shift(1).fillna(0.0)
    else:
        feats["news_sentiment"] = 0.0

    # Macro/fundamental features
    if days_to_earnings is not None:
        feats["days_to_earnings"] = float(days_to_earnings)
    else:
        feats["days_to_earnings"] = 30.0

    if implied_vol is not None:
        feats["implied_vol"] = float(implied_vol)
    else:
        feats["implied_vol"] = feats["vol_15"] * np.sqrt(252 * 390)

    # Target: return over each horizon (ONLY used during training, not prediction)
    for h in HORIZONS:
        feats[f"target_{h}"] = close.pct_change(h).shift(-h)

    return feats


def build_prediction_features(
    df: pd.DataFrame,
    context: Optional[dict[str, pd.DataFrame]] = None,
    news_sentiment: Optional[pd.Series] = None,
    days_to_earnings: Optional[float] = None,
    implied_vol: Optional[float] = None,
) -> Optional[pd.Series]:
    """Return a single feature row for the latest bar (for live prediction)."""
    feat_df = build_features(df, context, news_sentiment, days_to_earnings, implied_vol)
    if feat_df.empty:
        return None
    feature_cols = [c for c in feat_df.columns if not c.startswith("target_")]
    last_row = feat_df[feature_cols].dropna(how="all").iloc[-1]
    return last_row


def get_feature_cols(feat_df: pd.DataFrame) -> list[str]:
    return [c for c in feat_df.columns if not c.startswith("target_")]
