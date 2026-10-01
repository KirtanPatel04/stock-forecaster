"""GARCH(1,1) realized-volatility model for sizing confidence bands."""
import logging
from typing import Dict, Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

try:
    from arch import arch_model
    _ARCH_AVAILABLE = True
except ImportError:
    _ARCH_AVAILABLE = False
    logger.warning("arch package not available; falling back to realized vol for bands")


def estimate_vol_scaling(
    returns: pd.Series,
    horizons: list[int],
    annualize: bool = False,
) -> Dict[int, float]:
    """
    Fit GARCH(1,1) and return forecasted volatility (std) per horizon.
    Falls back to simple rolling realized vol if arch is unavailable.
    """
    r = returns.dropna()
    if len(r) < 50:
        base_vol = float(r.std()) if len(r) > 1 else 0.001
        return {h: base_vol * np.sqrt(h) for h in horizons}

    if _ARCH_AVAILABLE:
        try:
            scaled = r * 100  # arch works better with % returns
            am = arch_model(scaled, vol="Garch", p=1, q=1, dist="normal")
            res = am.fit(disp="off", show_warning=False)
            result = {}
            for h in horizons:
                fc = res.forecast(horizon=h, reindex=False)
                var_sum = float(fc.variance.iloc[-1].sum())
                vol = np.sqrt(max(var_sum, 0)) / 100  # back to decimal
                result[h] = vol
            return result
        except Exception as e:
            logger.debug("GARCH fit failed, using realized vol: %s", e)

    # Fallback: realized vol scaled by sqrt of horizon
    base_vol = float(r.tail(30).std())
    return {h: base_vol * np.sqrt(h) for h in horizons}


def build_garch_bands(
    returns: pd.Series,
    center_forecasts: Dict[int, float],
    horizons: list[int],
) -> Dict[int, Dict[str, float]]:
    """
    Use GARCH to estimate the per-horizon std, then wrap center forecasts
    with 50% and 80% normal CI bands.
    """
    vol_per_horizon = estimate_vol_scaling(returns, horizons)
    result = {}
    for h in horizons:
        vol = vol_per_horizon.get(h, 0.001)
        center = center_forecasts.get(h, 0.0)
        result[h] = {
            "vol": vol,
            "lower_80": center - 1.28 * vol,
            "upper_80": center + 1.28 * vol,
            "lower_50": center - 0.674 * vol,
            "upper_50": center + 0.674 * vol,
        }
    return result
