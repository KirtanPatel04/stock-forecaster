"""WebSocket connection manager — fan-out updates to all subscribers of a ticker."""
import asyncio
import logging
from typing import Dict, List

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        self._connections: Dict[str, List[WebSocket]] = {}

    async def connect(self, ticker: str, ws: WebSocket):
        await ws.accept()
        self._connections.setdefault(ticker, []).append(ws)
        logger.debug("WS connected: %s (now %d)", ticker, len(self._connections[ticker]))

    def disconnect(self, ticker: str, ws: WebSocket):
        conns = self._connections.get(ticker, [])
        if ws in conns:
            conns.remove(ws)
        logger.debug("WS disconnected: %s (now %d)", ticker, len(conns))

    async def broadcast(self, ticker: str, message: dict):
        conns = self._connections.get(ticker, [])
        dead = []
        for ws in conns:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ticker, ws)

    def active_tickers(self) -> List[str]:
        return [t for t, conns in self._connections.items() if conns]


manager = ConnectionManager()
