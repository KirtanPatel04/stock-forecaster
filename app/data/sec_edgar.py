"""SEC EDGAR client — 8-K and material event filings (no API key required)."""
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Optional

import httpx

logger = logging.getLogger(__name__)

EDGAR_BASE = "https://efts.sec.gov/LATEST/search-index"
EDGAR_FULL = "https://efts.sec.gov/LATEST/search-index?q=%22{ticker}%22&dateRange=custom&startdt={start}&enddt={end}&forms=8-K"
EDGAR_SEARCH = "https://efts.sec.gov/LATEST/search-index?q={query}&forms={forms}&dateRange=custom&startdt={start}&enddt={end}"

_HEADERS = {
    "User-Agent": "StockForecaster personal-use contact@example.com",
    "Accept": "application/json",
}


def get_recent_8k(ticker: str, days_back: int = 30) -> List[dict]:
    """Return recent 8-K filings for a ticker via EDGAR full-text search."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days_back)
    url = (
        f"https://efts.sec.gov/LATEST/search-index"
        f"?q=%22{ticker}%22"
        f"&forms=8-K"
        f"&dateRange=custom"
        f"&startdt={start.strftime('%Y-%m-%d')}"
        f"&enddt={end.strftime('%Y-%m-%d')}"
    )
    try:
        with httpx.Client(headers=_HEADERS, timeout=10) as client:
            resp = client.get(url)
            resp.raise_for_status()
            data = resp.json()
        hits = data.get("hits", {}).get("hits", [])
        results = []
        for h in hits:
            src = h.get("_source", {})
            results.append({
                "filed_at": src.get("file_date"),
                "form_type": src.get("form_type"),
                "company_name": src.get("display_names", [{}])[0].get("name", ""),
                "ticker": ticker,
                "description": src.get("period_of_report", ""),
                "accession": src.get("file_num", ""),
                "url": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company={ticker}&type=8-K",
            })
        return results
    except Exception as e:
        logger.warning("EDGAR 8-K fetch failed for %s: %s", ticker, e)
        return []


def get_company_cik(ticker: str) -> Optional[str]:
    """Look up a company's CIK from EDGAR company search."""
    url = f"https://www.sec.gov/cgi-bin/browse-edgar?company=&CIK={ticker}&type=8-K&dateb=&owner=include&count=5&search_text=&action=getcompany&output=atom"
    try:
        with httpx.Client(headers=_HEADERS, timeout=10) as client:
            resp = client.get(url)
            if resp.status_code == 200 and "cik=" in resp.text:
                import re
                m = re.search(r"CIK=(\d+)", resp.text)
                return m.group(1) if m else None
    except Exception:
        pass
    return None
