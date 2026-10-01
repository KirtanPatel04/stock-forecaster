"""Feature pipeline correctness tests."""
import numpy as np
import pandas as pd
import pytest

from app.forecasting.features import build_features, build_prediction_features, HORIZONS


def _make_bars(n: int = 400, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    timestamps = pd.date_range("2024-01-02 09:31", periods=n, freq="1min", tz="UTC")
    close = 100 * np.cumprod(1 + rng.normal(0, 0.001, n))
    df = pd.DataFrame({
        "open": close * (1 + rng.uniform(-0.001, 0.001, n)),
        "high": close * (1 + rng.uniform(0, 0.002, n)),
        "low": close * (1 - rng.uniform(0, 0.002, n)),
        "close": close,
        "volume": rng.integers(1000, 100000, n).astype(float),
        "vwap": close,
    }, index=timestamps)
    return df


def test_features_shape():
    df = _make_bars(400)
    feat = build_features(df)
    assert not feat.empty
    assert len(feat) == len(df)


def test_no_target_in_feature_cols():
    """Feature columns used for training/prediction must not include targets."""
    from app.forecasting.features import get_feature_cols
    df = _make_bars(400)
    feat = build_features(df)
    feature_cols = get_feature_cols(feat)
    for col in feature_cols:
        assert not col.startswith("target_"), f"Target leaked into features: {col}"


def test_targets_use_future_data():
    """Targets must look forward (they are only used in training, never prediction)."""
    df = _make_bars(400)
    feat = build_features(df)
    for h in HORIZONS:
        col = f"target_{h}"
        assert col in feat.columns, f"Missing target column: {col}"
        # last h rows should be NaN (no future data available)
        tail = feat[col].iloc[-h:]
        assert tail.isna().all() or len(tail) == 0, f"Target {col} has values beyond data end"


def test_no_future_leak_in_features():
    """
    Core leakage check: if we shift the close price, features at time t must
    not change — i.e., features must be computed solely from data BEFORE time t.
    """
    df = _make_bars(400)
    df_perturbed = df.copy()
    # Change the last bar's close dramatically — feature at row N-2 must not change
    df_perturbed.iloc[-1, df_perturbed.columns.get_loc("close")] *= 10.0

    feat_orig = build_features(df)
    feat_pert = build_features(df_perturbed)

    from app.forecasting.features import get_feature_cols
    feature_cols = get_feature_cols(feat_orig)

    # All rows except the last (which directly uses shifted data) must be identical
    for col in feature_cols:
        if col in ("minute_of_day", "day_of_week", "time_sin", "time_cos") or col.startswith("dow_"):
            continue
        orig = feat_orig[col].iloc[:-2].dropna()
        pert = feat_pert[col].iloc[:-2].dropna()
        shared = orig.index.intersection(pert.index)
        if len(shared) == 0:
            continue
        diff = (orig.loc[shared] - pert.loc[shared]).abs().max()
        assert diff < 1e-9, f"Leakage detected in feature '{col}': max diff={diff}"


def test_prediction_features_no_nan():
    """The single row used for live prediction should have no NaN values in key features."""
    df = _make_bars(400)
    row = build_prediction_features(df)
    assert row is not None
    nan_cols = row[row.isna()].index.tolist()
    critical = [c for c in nan_cols if not c.startswith("spy") and not c.startswith("qqq")]
    assert len(critical) == 0, f"NaN in prediction features: {critical}"


def test_context_features():
    """Context (SPY/QQQ) features should be built without error when context is provided."""
    df = _make_bars(400)
    spy = _make_bars(400, seed=99)
    feat = build_features(df, context={"SPY": spy})
    assert "spy_ret_1" in feat.columns
    assert "spy_ret_5" in feat.columns


def test_news_sentiment_alignment():
    """News sentiment series should be forward-filled to bar timestamps."""
    df = _make_bars(200)
    sentiment = pd.Series(
        {df.index[50]: 0.8, df.index[100]: -0.3},
    )
    feat = build_features(df, news_sentiment=sentiment)
    # Before first news: 0.0
    assert feat["news_sentiment"].iloc[10] == 0.0
    # After first news (row 51+): should be 0.8
    assert feat["news_sentiment"].iloc[60] == pytest.approx(0.8, abs=1e-6)
    # After second news (row 101+): should be -0.3
    assert feat["news_sentiment"].iloc[150] == pytest.approx(-0.3, abs=1e-6)
