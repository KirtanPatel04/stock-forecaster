"""AI news sentiment scoring via Gemini (preferred) or Claude fallback.
Results are cached in the DB to avoid duplicate API calls.
"""
import json
import logging
from typing import Optional

from ..config import settings

logger = logging.getLogger(__name__)


def _gemini_client():
    from google import genai
    return genai.Client(api_key=settings.gemini_api_key)


def _gemini_text(prompt: str) -> str:
    client = _gemini_client()
    response = client.models.generate_content(
        model="gemini-3.5-flash-lite",
        contents=prompt,
    )
    return response.text.strip()


def _parse_score(result: dict) -> dict:
    return {
        "relevance": float(result.get("relevance", 0.5)),
        "sentiment": float(result.get("sentiment", 0.0)),
        "surprise": float(result.get("surprise", 0.0)),
        "expected_impact": float(result.get("expected_impact", 0.0)),
    }


def _score_with_gemini(ticker: str, headline: str, summary: str) -> dict:
    text = headline
    if summary and summary != headline:
        text = f"{headline}\n\n{summary[:500]}"

    prompt = f"""Analyze this news item for stock ticker {ticker}.

{text}

Respond with only valid JSON (no explanation, no markdown):
{{
  "relevance": <0.0 to 1.0, how directly relevant to {ticker}>,
  "sentiment": <-1.0 to 1.0, expected price impact direction>,
  "surprise": <0.0 to 1.0, how unexpected/surprising>,
  "expected_impact": <0.0 to 1.0, expected magnitude of price move>
}}"""

    raw = _gemini_text(prompt)
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return _parse_score(json.loads(raw))


def score_news_batch_gemini(ticker: str, articles: list[dict]) -> list[dict]:
    """Score multiple articles for the same ticker in a single Gemini call."""
    lines = []
    for i, a in enumerate(articles):
        text = a.get("headline", "")
        if a.get("summary") and a["summary"] != text:
            text += f" | {a['summary'][:200]}"
        lines.append(f"{i}: {text}")

    prompt = f"""Score each news item for stock ticker {ticker}. Return a JSON array with one object per item (same order).

Items:
{chr(10).join(lines)}

Each object:
{{"relevance": <0.0-1.0>, "sentiment": <-1.0 to 1.0>, "surprise": <0.0-1.0>, "expected_impact": <0.0-1.0>}}

Respond with only the JSON array, no explanation, no markdown."""

    raw = _gemini_text(prompt)
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    results = json.loads(raw)
    if not isinstance(results, list) or len(results) != len(articles):
        raise ValueError("Unexpected batch response shape")
    return [_parse_score(r) for r in results]


def _score_with_claude(ticker: str, headline: str, summary: str) -> dict:
    import anthropic
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    text = headline
    if summary and summary != headline:
        text = f"{headline}\n\n{summary[:500]}"

    prompt = f"""Analyze this news item for stock ticker {ticker}.

{text}

Respond with only valid JSON (no explanation, no markdown):
{{
  "relevance": <0.0 to 1.0, how directly relevant to {ticker}>,
  "sentiment": <-1.0 to 1.0, expected price impact direction>,
  "surprise": <0.0 to 1.0, how unexpected/surprising>,
  "expected_impact": <0.0 to 1.0, expected magnitude of price move>
}}"""

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=128,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = message.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    result = json.loads(raw)
    return {
        "relevance": float(result.get("relevance", 0.5)),
        "sentiment": float(result.get("sentiment", 0.0)),
        "surprise": float(result.get("surprise", 0.0)),
        "expected_impact": float(result.get("expected_impact", 0.0)),
    }


def score_news(ticker: str, headline: str, summary: str = "") -> dict:
    """Score a news item using Gemini if configured, otherwise Claude."""
    default = {"relevance": 0.5, "sentiment": 0.0, "surprise": 0.0, "expected_impact": 0.0}

    if settings.gemini_api_key:
        try:
            return _score_with_gemini(ticker, headline, summary)
        except Exception as e:
            logger.warning("Gemini scoring failed for %s: %s", ticker, e)

    if settings.anthropic_api_key:
        try:
            return _score_with_claude(ticker, headline, summary)
        except Exception as e:
            logger.warning("Claude scoring failed for %s: %s", ticker, e)

    logger.info("No AI API key configured — returning neutral sentiment")
    return default


def score_news_cached(db, news_item) -> dict:
    """Score a NewsItem, using the DB cache if already scored."""
    if news_item.sentiment_cached:
        return {
            "relevance": news_item.relevance_score or 0.5,
            "sentiment": news_item.sentiment_score or 0.0,
            "surprise": news_item.surprise_level or 0.0,
            "expected_impact": news_item.expected_impact or 0.0,
        }

    result = score_news(
        news_item.ticker or "",
        news_item.headline,
        news_item.summary or "",
    )

    news_item.relevance_score = result["relevance"]
    news_item.sentiment_score = result["sentiment"]
    news_item.surprise_level = result["surprise"]
    news_item.expected_impact = result["expected_impact"]
    news_item.sentiment_cached = True
    db.commit()
    return result


def _summarize_with_gemini(ticker: str, news_text: str, context: str) -> dict:
    prompt = f"""You are analyzing {ticker} for next-session price direction.

Context:
{context}

Recent news:
{news_text}

Respond with only valid JSON (no markdown, no explanation):
{{
  "lean": "bullish" or "bearish" or "neutral",
  "probability": <0.0 to 1.0, probability of positive open>,
  "expected_change_low": <expected worst-case % change, e.g. -0.05>,
  "expected_change_high": <expected best-case % change, e.g. 0.08>,
  "key_reasons": [<up to 5 concise bullet points>],
  "summary": <2-3 sentences in plain language>
}}"""

    raw = _gemini_text(prompt)
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw)


def _summarize_with_claude(ticker: str, news_text: str, context: str) -> dict:
    import anthropic
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    prompt = f"""You are analyzing {ticker} for next-session price direction.

Context:
{context}

Recent news:
{news_text}

Respond with only valid JSON (no markdown, no explanation):
{{
  "lean": "bullish" or "bearish" or "neutral",
  "probability": <0.0 to 1.0, probability of positive open>,
  "expected_change_low": <expected worst-case % change, e.g. -0.05>,
  "expected_change_high": <expected best-case % change, e.g. 0.08>,
  "key_reasons": [<up to 5 concise bullet points>],
  "summary": <2-3 sentences in plain language>
}}"""

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=600,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = message.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw)


def summarize_news_for_report(
    ticker: str,
    headlines_and_summaries: list[dict],
    context: str = "",
) -> dict:
    """Generate structured after-hours report using Gemini or Claude."""
    fallback = {
        "lean": "neutral",
        "probability": 0.5,
        "expected_change_low": -0.02,
        "expected_change_high": 0.02,
        "key_reasons": ["No AI API key configured"],
        "summary": "Configure GEMINI_API_KEY or ANTHROPIC_API_KEY to enable analysis.",
    }

    if not headlines_and_summaries:
        return fallback

    news_text = "\n".join(
        f"- [{n.get('source', '?')}] {n.get('headline', '')} | {n.get('summary', '')[:200]}"
        for n in headlines_and_summaries[:20]
    )

    if settings.gemini_api_key:
        try:
            return _summarize_with_gemini(ticker, news_text, context)
        except Exception as e:
            logger.warning("Gemini report failed for %s: %s", ticker, e)

    if settings.anthropic_api_key:
        try:
            return _summarize_with_claude(ticker, news_text, context)
        except Exception as e:
            logger.warning("Claude report failed for %s: %s", ticker, e)

    return fallback
