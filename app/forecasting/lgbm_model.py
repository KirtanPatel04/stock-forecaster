"""LightGBM quantile regression model for multi-horizon forecasting."""
import logging
import os
from typing import Dict, Optional, Tuple

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd

from .features import HORIZONS, build_features, get_feature_cols

logger = logging.getLogger(__name__)

QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9]
MODEL_DIR = "./models"
os.makedirs(MODEL_DIR, exist_ok=True)


def _lgb_params(alpha: float) -> dict:
    return {
        "objective": "quantile",
        "alpha": alpha,
        "metric": "quantile",
        "num_leaves": 31,
        "learning_rate": 0.05,
        "n_estimators": 300,
        "min_child_samples": 20,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "random_state": 42,
        "verbose": -1,
        "n_jobs": -1,
    }


class LGBMQuantileModel:
    """Separate LightGBM model per (ticker, horizon, quantile)."""

    def __init__(self, ticker: str):
        self.ticker = ticker
        self.models: Dict[Tuple[int, float], lgb.LGBMRegressor] = {}
        self.feature_cols: Optional[list] = None
        self.is_trained = False

    def _model_path(self, horizon: int, quantile: float) -> str:
        q_str = str(int(quantile * 100))
        return os.path.join(MODEL_DIR, f"{self.ticker}_{horizon}_{q_str}.joblib")

    def train(
        self,
        feat_df: pd.DataFrame,
        min_samples: int = 200,
    ) -> bool:
        """Train models for all horizons and quantiles. Returns True if trained successfully."""
        self.feature_cols = get_feature_cols(feat_df)
        X = feat_df[self.feature_cols].copy()

        trained_any = False
        for horizon in HORIZONS:
            target_col = f"target_{horizon}"
            if target_col not in feat_df.columns:
                continue

            y = feat_df[target_col]
            mask = X.notna().all(axis=1) & y.notna()
            X_train = X[mask]
            y_train = y[mask]

            if len(X_train) < min_samples:
                logger.debug("Not enough samples for %s h=%d: %d", self.ticker, horizon, len(X_train))
                continue

            for q in QUANTILES:
                model = lgb.LGBMRegressor(**_lgb_params(q))
                model.fit(X_train, y_train)
                self.models[(horizon, q)] = model
                try:
                    joblib.dump(model, self._model_path(horizon, q))
                except Exception as e:
                    logger.debug("Could not save model: %s", e)
            trained_any = True

        self.is_trained = trained_any
        return trained_any

    def load(self) -> bool:
        """Load pre-trained models from disk."""
        loaded = 0
        for horizon in HORIZONS:
            for q in QUANTILES:
                path = self._model_path(horizon, q)
                if os.path.exists(path):
                    try:
                        self.models[(horizon, q)] = joblib.load(path)
                        loaded += 1
                    except Exception:
                        pass
        self.is_trained = loaded > 0
        return self.is_trained

    def predict(self, feature_row: pd.Series) -> Dict[int, Dict[str, float]]:
        """Return predictions for all horizons: {horizon: {q10, q25, q50, q75, q90}}."""
        if not self.is_trained or self.feature_cols is None:
            return {}

        x = feature_row[self.feature_cols].values.reshape(1, -1)
        results: Dict[int, Dict[str, float]] = {}

        for horizon in HORIZONS:
            preds = {}
            for q in QUANTILES:
                key = (horizon, q)
                if key in self.models:
                    try:
                        val = float(self.models[key].predict(x)[0])
                        preds[f"q{int(q*100)}"] = val
                    except Exception:
                        pass
            if preds:
                results[horizon] = preds

        return results

    def feature_importance(self, horizon: int = 15) -> Optional[pd.Series]:
        key = (horizon, 0.5)
        if key not in self.models:
            return None
        model = self.models[key]
        if self.feature_cols is None:
            return None
        return pd.Series(
            model.feature_importances_,
            index=self.feature_cols,
        ).sort_values(ascending=False)


_model_registry: Dict[str, LGBMQuantileModel] = {}


def get_model(ticker: str) -> LGBMQuantileModel:
    if ticker not in _model_registry:
        m = LGBMQuantileModel(ticker)
        m.load()
        _model_registry[ticker] = m
    return _model_registry[ticker]
