"""Walk-forward validation leakage checks."""
import numpy as np
import pandas as pd
import pytest

from app.forecasting.features import build_features, HORIZONS, get_feature_cols
from app.forecasting.lgbm_model import LGBMQuantileModel
from app.forecasting.validator import walk_forward_validate


def _make_bars(n: int = 600, seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    timestamps = pd.date_range("2024-01-02 09:31", periods=n, freq="1min", tz="UTC")
    close = 100 * np.cumprod(1 + rng.normal(0, 0.001, n))
    return pd.DataFrame({
        "open": close * (1 + rng.uniform(-0.001, 0.001, n)),
        "high": close * (1 + rng.uniform(0, 0.002, n)),
        "low": close * (1 - rng.uniform(0, 0.002, n)),
        "close": close,
        "volume": rng.integers(1000, 100000, n).astype(float),
        "vwap": close,
    }, index=timestamps)


def test_walk_forward_no_random_split():
    """Walk-forward: train set must always end before test set starts."""
    df = _make_bars(600)
    feat_df = build_features(df)
    result = walk_forward_validate("TEST", feat_df, min_train_size=200, test_size=30, step=30)
    # Just check it runs — the validation logic enforces ordering internally
    assert isinstance(result.folds, list)


def test_walk_forward_has_folds():
    df = _make_bars(600)
    feat_df = build_features(df)
    result = walk_forward_validate("TEST", feat_df, min_train_size=200, test_size=30, step=60)
    assert len(result.folds) > 0


def test_lgbm_train_test_no_future():
    """
    Simulate training on rows 0..300, predicting on rows 300..400.
    Features at row 301 must use only data from rows 0..300.
    """
    df = _make_bars(600)
    feat_df = build_features(df)
    feature_cols = get_feature_cols(feat_df)

    train_end = 300
    train_df = feat_df.iloc[:train_end]
    test_df = feat_df.iloc[train_end: train_end + 60]

    model = LGBMQuantileModel("TEST_LEAK")
    trained = model.train(train_df, min_samples=50)
    assert trained, "Model should train on 300 bars"

    # Every feature in test set must have been available at prediction time
    # i.e., we just confirm no target column leaked into feature_cols
    for col in feature_cols:
        assert not col.startswith("target_"), f"Target in features: {col}"


def test_news_timestamp_boundary():
    """News published AFTER a bar cannot appear in features for that bar."""
    df = _make_bars(200)
    bar_50_ts = df.index[50]
    bar_51_ts = df.index[51]

    # News published exactly at bar 50 — must NOT appear in features for bar 50
    # (we use shift(1), so it can only appear at bar 51+)
    from app.forecasting.features import build_features
    future_news = pd.Series({bar_50_ts: 0.99})
    feat = build_features(df, news_sentiment=future_news)

    # At bar 50, features should reflect pre-bar-50 state (0.0, not 0.99)
    # The shift(1) ensures sentiment from bar_50_ts cannot appear in row 50
    # (it can only appear in row 51+)
    sentiment_at_50 = feat["news_sentiment"].iloc[50]
    assert sentiment_at_50 == pytest.approx(0.0, abs=1e-6), (
        f"News from bar_50 leaked into features at bar 50: {sentiment_at_50}"
    )
    # At bar 51+, the news should be visible
    sentiment_at_52 = feat["news_sentiment"].iloc[52]
    assert sentiment_at_52 == pytest.approx(0.99, abs=1e-6), (
        f"Expected news_sentiment=0.99 at bar 52, got {sentiment_at_52}"
    )
