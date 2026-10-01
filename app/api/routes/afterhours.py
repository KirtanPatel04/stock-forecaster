"""After-hours / pre-market analysis endpoint."""
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ...database import get_db
from ...models.schemas import AfterHoursReportOut
from ...services.afterhours_analyzer import build_afterhours_report, score_past_reports

router = APIRouter(prefix="/afterhours", tags=["afterhours"])
logger = logging.getLogger(__name__)


@router.get("/{ticker}", response_model=AfterHoursReportOut)
def get_afterhours_report(
    ticker: str,
    db: Session = Depends(get_db),
):
    ticker = ticker.upper()
    try:
        report = build_afterhours_report(db, ticker)
        return report
    except Exception as e:
        logger.exception("After-hours report failed for %s", ticker)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/score")
def score_reports(db: Session = Depends(get_db)):
    """Score past after-hours reports against actual opens."""
    n = score_past_reports(db)
    return {"scored": n}
