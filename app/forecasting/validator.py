"""Walk-forward validation — no random splits, no lookahead leakage."""
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from .baseline import baseline_mae
from .features import HORIZONS, build_features, get_feature_cols
from .lgbm_model import QUANTILES, LGBMQuantileModel

logger = logging.getLogger(__name__)


@dataclass
class FoldResult:
    horizon: int
    n_test: int
    mae_model: float
    mae_naive: float
    beats_naive: bool
    directional_accuracy: float
    band_80_coverage: float
    band_50_coverage: float


@dataclass
class WalkForwardResult:
    ticker: str
    folds: List[FoldResult]
    horizon_summaries: Dict[int, dict] = field(default_factory=dict)

    def __post_init__(self):
        for h in HORIZONS:
            h_folds = [f for f in self.folds if f.horizon == h]
            if not h_folds:
                continue
            self.horizon_summaries[h] = {
                "horizon_minutes": h,
                "n_folds": len(h_folds),
                "mean_mae_model": float(np.mean([f.mae_model for f in h_folds])),
                "mean_mae_naive": float(np.mean([f.mae_naive for f in h_folds])),
                "beats_naive_fraction": float(np.mean([f.beats_naive for f in h_folds])),
                "mean_directional_accuracy": float(np.mean([f.directional_accuracy for f in h_folds])),
                "mean_80_coverage": float(np.mean([f.band_80_coverage for f in h_folds])),
                "mean_50_coverage": float(np.mean([f.band_50_coverage for f in h_folds])),
            }


def walk_forward_validate(
    ticker: str,
    feat_df: pd.DataFrame,
    min_train_size: int = 300,
    test_size: int = 60,
    step: int = 60,
) -> WalkForwardResult:
    """
    Walk-forward cross-validation.

    Train on rows 0..i, test on rows i..(i+test_size), advance by step.
    Never uses future data in training or feature construction.
    """
    feat_cols = get_feature_cols(feat_df)
    n = len(feat_df)
    folds: List[FoldResult] = []

    for train_end in range(min_train_size, n - test_size, step):
        train_df = feat_df.iloc[:train_end]
        test_df = feat_df.iloc[train_end: train_end + test_size]

        model = LGBMQuantileModel(ticker)
        trained = model.train(train_df, min_samples=min_train_size // 2)
        if not trained:
            continue

        for h in HORIZONS:
            target_col = f"target_{h}"
            if target_col not in test_df.columns:
                continue

            X_test = test_df[feat_cols].dropna()
            y_test = test_df[target_col].loc[X_test.index].dropna()
            X_test = X_test.loc[y_test.index]

            if len(X_test) < 5:
                continue

            if (h, 0.5) not in model.models:
                continue

            y_pred_median = model.models[(h, 0.5)].predict(X_test)
            y_pred_q10 = model.models.get((h, 0.1), model.models[(h, 0.5)]).predict(X_test)
            y_pred_q90 = model.models.get((h, 0.9), model.models[(h, 0.5)]).predict(X_test)
            y_pred_q25 = model.models.get((h, 0.25), model.models[(h, 0.5)]).predict(X_test)
            y_pred_q75 = model.models.get((h, 0.75), model.models[(h, 0.5)]).predict(X_test)

            y_arr = y_test.values
            mae_model = float(np.mean(np.abs(y_pred_median - y_arr)))
            mae_naive = float(np.mean(np.abs(y_arr)))  # naive: predict 0

            dir_acc = float(np.mean(np.sign(y_pred_median) == np.sign(y_arr)))
            cov_80 = float(np.mean((y_arr >= y_pred_q10) & (y_arr <= y_pred_q90)))
            cov_50 = float(np.mean((y_arr >= y_pred_q25) & (y_arr <= y_pred_q75)))

            folds.append(FoldResult(
                horizon=h,
                n_test=len(y_arr),
                mae_model=mae_model,
                mae_naive=mae_naive,
                beats_naive=mae_model < mae_naive,
                directional_accuracy=dir_acc,
                band_80_coverage=cov_80,
                band_50_coverage=cov_50,
            ))

    return WalkForwardResult(ticker=ticker, folds=folds)
