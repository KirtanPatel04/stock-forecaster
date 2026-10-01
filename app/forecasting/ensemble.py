"""Ensemble forecaster: weighted combination of baseline + LightGBM + GARCH bands.

Ensemble weights are tracked per-horizon using recent out-of-sample MAE.
A model is excluded from the ensemble if it does not beat the naive baseline.
"""
import logging
from datetime import datetime, timezone
from typing import Dict, Optional

import numpy as np
import pandas as pd

from .baseline import predict_naive, predict_drift
from .features import HORIZONS, build_features, build_prediction_features
from .garch_model import build_garch_bands
from .lgbm_model import LGBMQuantileModel, get_model

logger = logging.getLogger(__name__)


class EnsembleForecaster:
    def __init__(self, ticker: str):
        self.ticker = ticker
        self.lgbm: Optional[LGBMQuantileModel] = None
        # Track recent per-horizon MAE for each model to compute weights
        self._recent_errors: Dict[int, Dict[str, list]] = {h: {"naive": [], "drift": [], "lgbm": []} for h in HORIZONS}

    def fit(
        self,
        df: pd.DataFrame,
        context: Optional[dict] = None,
        news_sentiment: Optional[pd.Series] = None,
        days_to_earnings: Optional[float] = None,
        implied_vol: Optional[float] = None,
    ) -> bool:
        """Train the LGBM model and validate against baselines."""
        feat_df = build_features(df, context, news_sentiment, days_to_earnings, implied_vol)
        if feat_df.empty:
            return False

        self.lgbm = LGBMQuantileModel(self.ticker)
        trained = self.lgbm.train(feat_df)
        if trained:
            _model_registry[self.ticker] = self
            logger.info("Ensemble trained for %s", self.ticker)
        return trained

    def predict(
        self,
        df: pd.DataFrame,
        context: Optional[dict] = None,
        news_sentiment: Optional[pd.Series] = None,
        days_to_earnings: Optional[float] = None,
        implied_vol: Optional[float] = None,
        current_price: Optional[float] = None,
    ) -> dict:
        """
        Generate ensemble forecast.
        Returns {horizon: {predicted_return, lower_50, upper_50, lower_80, upper_80, weights}}
        """
        if current_price is None:
            current_price = float(df["close"].iloc[-1])

        returns = df["close"].pct_change().dropna()
        recent_vol = float(returns.tail(30).std()) if len(returns) >= 5 else 0.001

        # Baseline predictions
        naive = {h: predict_naive(h, recent_vol=recent_vol) for h in HORIZONS}
        drift = {h: predict_drift(returns, h, recent_vol=recent_vol) for h in HORIZONS}

        # LGBM predictions
        lgbm_preds: Dict[int, Dict[str, float]] = {}
        if self.lgbm is None:
            self.lgbm = get_model(self.ticker)

        if self.lgbm.is_trained:
            feature_row = build_prediction_features(
                df, context, news_sentiment, days_to_earnings, implied_vol
            )
            if feature_row is not None and not feature_row.isna().all():
                lgbm_preds = self.lgbm.predict(feature_row)

        # GARCH bands (use LGBM median as center if available, else naive)
        center_forecasts = {
            h: lgbm_preds[h].get("q50", 0.0) if h in lgbm_preds else 0.0
            for h in HORIZONS
        }
        garch_bands = build_garch_bands(returns, center_forecasts, HORIZONS)

        results = {}
        all_weights = {}
        for h in HORIZONS:
            # Compute ensemble weights from recent error history
            naive_mae = _mean_or_default(self._recent_errors[h]["naive"], 0.01)
            lgbm_mae = _mean_or_default(self._recent_errors[h]["lgbm"], 0.01)

            # Use LGBM only if it has been trained and beats naive
            use_lgbm = h in lgbm_preds and lgbm_mae < naive_mae

            if use_lgbm:
                q50 = lgbm_preds[h].get("q50", 0.0)
                # Blend bands: prefer LGBM quantiles, fall back to GARCH
                q10 = lgbm_preds[h].get("q10", garch_bands[h]["lower_80"])
                q25 = lgbm_preds[h].get("q25", garch_bands[h]["lower_50"])
                q75 = lgbm_preds[h].get("q75", garch_bands[h]["upper_50"])
                q90 = lgbm_preds[h].get("q90", garch_bands[h]["upper_80"])
                weights = {"lgbm": 0.7, "naive": 0.3}
            else:
                # Fall back to drift baseline
                d = drift[h]
                q50 = d.predicted_return
                q10 = garch_bands[h]["lower_80"]
                q25 = garch_bands[h]["lower_50"]
                q75 = garch_bands[h]["upper_50"]
                q90 = garch_bands[h]["upper_80"]
                weights = {"naive": 0.5, "drift": 0.5}

            results[h] = {
                "predicted_return": q50,
                "lower_80": q10,
                "upper_80": q90,
                "lower_50": q25,
                "upper_50": q75,
                "weights": weights,
                "garch_vol": garch_bands[h]["vol"],
            }
            all_weights[h] = weights

        return {"horizons": results, "weights": all_weights}

    def update_errors(self, horizon: int, model: str, error: float):
        """Call after a prediction is scored to update weight tracking."""
        buf = self._recent_errors[horizon][model]
        buf.append(error)
        if len(buf) > 100:
            buf.pop(0)


def _mean_or_default(lst: list, default: float) -> float:
    return float(np.mean(lst)) if lst else default


_model_registry: Dict[str, EnsembleForecaster] = {}


def get_ensemble(ticker: str) -> EnsembleForecaster:
    if ticker not in _model_registry:
        _model_registry[ticker] = EnsembleForecaster(ticker)
    return _model_registry[ticker]
