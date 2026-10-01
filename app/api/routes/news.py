"""News endpoints."""
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ...database import get_db
from ...data.data_manager import fetch_and_cache_news, get_cached_news
from ...forecasting.claude_sentiment import score_news_cached
from ...models.schemas import NewsItemOut

router = APIRouter(prefix="/news", tags=["news"])
logger = logging.getLogger(__name__)


@router.get("/{ticker}", response_model=List[NewsItemOut])
def get_news(
    ticker: str,
    limit: int = Query(50, ge=1, le=200),
    days_back: int = Query(3, ge=1, le=30),
    refresh: bool = Query(False),
    score: bool = Query(True),
    db: Session = Depends(get_db),
):
    ticker = ticker.upper()

    if refresh:
        try:
            fetch_and_cache_news(db, ticker, days_back=days_back)
        except Exception as e:
            logger.warning("News refresh failed for %s: %s", ticker, e)

    since = datetime.now(timezone.utc) - timedelta(days=days_back)
    items = get_cached_news(db, ticker, limit=limit, since=since)

    if not items:
        try:
            fetch_and_cache_news(db, ticker, days_back=days_back)
            items = get_cached_news(db, ticker, limit=limit, since=since)
        except Exception as e:
            logger.warning("Could not fetch news for %s: %s", ticker, e)

    if score:
        for item in items:
            if not item.sentiment_cached:
                try:
                    score_news_cached(db, item)
                except Exception as e:
                    logger.debug("Scoring failed for news %d: %s", item.id, e)

    return [NewsItemOut.model_validate(item) for item in items]
