"""FastAPI application entry point."""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import init_db
from .api.routes import stocks, news, forecast, afterhours, quick_analysis, movers, daytrade

logging.basicConfig(
    level=logging.DEBUG if settings.debug else logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing database...")
    init_db()
    logger.info("Stock Forecaster API ready.")
    yield
    logger.info("Shutting down.")


app = FastAPI(
    title="Stock Forecaster API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "https://kirtanpatel04.github.io"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(stocks.router, prefix="/api")
app.include_router(news.router, prefix="/api")
app.include_router(forecast.router, prefix="/api")
app.include_router(afterhours.router, prefix="/api")
app.include_router(quick_analysis.router, prefix="/api")
app.include_router(movers.router, prefix="/api")
app.include_router(daytrade.router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok", "debug": settings.debug}
