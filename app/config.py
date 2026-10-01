from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    alpaca_api_key: str = ""
    alpaca_secret_key: str = ""
    alpaca_base_url: str = "https://paper-api.alpaca.markets"
    polygon_api_key: str = ""
    finnhub_api_key: str = ""
    anthropic_api_key: str = ""
    gemini_api_key: str = ""
    database_url: str = "sqlite:///./stock_forecaster.db"
    debug: bool = False

    model_config = {"env_file": ".env", "case_sensitive": False}


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
