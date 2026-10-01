"""Baseline models: naive (return=0) and drift. Every other model must beat these."""
import numpy as np
import pandas as pd
from typing import Optional
from dataclasses import dataclass, field


@dataclass
class BaselinePrediction:
    name: str
    predicted_return: float
    lower_80: float
    upper_80: float
    lower_50: float
    upper_50: float


def predict_naive(horizon: int, recent_vol: Optional[float] = None, sigma_mult: float = 1.0) -> BaselinePrediction:
    """Naive forecast: price stays the same (return = 0)."""
    vol = (recent_vol or 0.001) * np.sqrt(horizon) * sigma_mult
    return BaselinePrediction(
        name="naive",
        predicted_return=0.0,
        lower_80=-1.28 * vol,
        upper_80=1.28 * vol,
        lower_50=-0.674 * vol,
        upper_50=0.674 * vol,
    )


def predict_drift(
    recent_returns: pd.Series,
    horizon: int,
    lookback: int = 10,
    recent_vol: Optional[float] = None,
    sigma_mult: float = 1.0,
) -> BaselinePrediction:
    """Drift model: extrapolate recent mean return."""
    if len(recent_returns) < lookback:
        drift = 0.0
        vol = (recent_vol or 0.001) * np.sqrt(horizon)
    else:
        r = recent_returns.dropna().iloc[-lookback:]
        drift = float(r.mean()) * horizon
        vol = float(r.std()) * np.sqrt(horizon) * sigma_mult
        if np.isnan(drift):
            drift = 0.0
        if np.isnan(vol) or vol <= 0:
            vol = (recent_vol or 0.001) * np.sqrt(horizon)

    return BaselinePrediction(
        name="drift",
        predicted_return=drift,
        lower_80=drift - 1.28 * vol,
        upper_80=drift + 1.28 * vol,
        lower_50=drift - 0.674 * vol,
        upper_50=drift + 0.674 * vol,
    )


def baseline_directional_accuracy(y_true: pd.Series) -> float:
    """What fraction of moves would the naive (return=0) model get right?
    Since naive predicts 0, it's correct whenever actual is also 0 — so baseline = 0.5."""
    n = len(y_true.dropna())
    return 0.5 if n == 0 else float((y_true.dropna() == 0).sum() / n)


def baseline_mae(y_true: pd.Series) -> float:
    """MAE of the naive model (always predicts 0)."""
    y = y_true.dropna()
    if len(y) == 0:
        return float("nan")
    return float(y.abs().mean())
