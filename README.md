# Stock Forecaster

A personal stock forecasting web app that runs entirely locally.

## Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11+, FastAPI, SQLAlchemy, SQLite |
| ML | LightGBM (quantile regression), GARCH (arch), scikit-learn |
| AI | Claude API (`claude-sonnet-4-6`) for news sentiment & reports |
| Frontend | React 18, Vite, TypeScript, lightweight-charts (TradingView) |
| Data | Alpaca Markets (prices), Finnhub (news/earnings), SEC EDGAR (8-K) |

---

## Required API Keys

| Service | Where to get it | Used for |
|---|---|---|
| **Alpaca** | https://alpaca.markets/ — free paper account | Live prices, streaming bars, historical data |
| **Finnhub** | https://finnhub.io/ — free tier | Company news, earnings calendar, macro events |
| **Anthropic** | https://console.anthropic.com/ | News sentiment scoring, after-hours reports |
| Polygon.io *(optional)* | https://polygon.io/ | Fallback price data |

---

## Setup

### 1. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env and fill in your API keys
```

### 2. Frontend

```bash
cd frontend
npm install
```

---

## Running

### Start backend (terminal 1)

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

### Start frontend (terminal 2)

```bash
cd frontend
npm run dev
```

Open **http://localhost:5173** in your browser.

---

## How to Use

### Live Chart (Feature 1)

1. Type a ticker symbol (e.g. `AAPL`) and click **Load**
2. Click **Train & Forecast** — this fetches ~30 days of 1-minute bars and trains the model
3. The chart shows live candlesticks streaming via WebSocket
4. Enter your buy price in "My Position" to see a yellow entry line and live P&L
5. Colored dots on the chart are news markers — green = bullish, red = bearish
6. The blue dashed line is the forecast center; shaded bands are 50% and 80% confidence intervals
7. A yellow banner shows the suggested exit window (highest forecast upside vs downside)

### After-Hours Analysis (Feature 3)

1. Go to the **AI Report** tab
2. Enter a ticker and click **Analyze**
3. Claude reads all recent news, earnings data, SEC filings, and macro context
4. Output: lean (bullish/bearish/neutral), probability, expected price range, key reasons

---

## Forecasting Engine

The ensemble has three layers:

1. **Baselines**: naive (predict return=0) and drift (recent mean return). Every other model must beat these to be weighted in.
2. **LightGBM quantile regression**: trained on engineered features with multiple quantile objectives (q10, q25, q50, q75, q90) → gives forecast + confidence bands directly from the model.
3. **GARCH(1,1)**: fits a volatility model on recent returns to size the confidence bands when LightGBM bands are unavailable.

**Features include**: multi-lookback returns, rolling volatility, VWAP distance, RSI, MACD, ATR, volume ratios, time-of-day (sine/cosine encoded), day-of-week, SPY/QQQ/sector ETF relative returns, days to earnings, news sentiment score from Claude, implied volatility.

**Validation**: walk-forward only — train on past data, test on the next unseen window, roll forward. Never random train/test splits.

**Leakage prevention**: every feature uses `.shift(1)` so only data available *before* the current bar is used. News sentiment is forward-filled from the news timestamp, meaning a news item can only affect features for bars *after* it was published.

---

## Running Tests

```bash
cd backend
source .venv/bin/activate
pytest tests/ -v
```

Key tests:
- `test_no_future_leak_in_features` — perturbation test: changing the last bar must not affect features for earlier bars
- `test_news_timestamp_boundary` — news published at bar T must not appear in features until bar T+1
- `test_walk_forward_no_random_split` — validates training/test ordering
- `test_no_target_in_feature_cols` — ensures target columns never leak into the feature vector

---

## Database

SQLite at `backend/stock_forecaster.db`. Tables:

| Table | Purpose |
|---|---|
| `price_bars` | OHLCV bars (1m, 5m, 1d, etc.) for all tickers |
| `news_items` | Headlines + Claude sentiment scores (cached) |
| `predictions` | Every live prediction + actual outcome once scored |
| `afterhours_reports` | After-hours analysis reports + actual open direction |
| `earnings_events` | Earnings calendar with EPS estimates/actuals |
| `macro_events` | Scheduled macro events (CPI, Fed, jobs) |

---

## Rate Limits

- **Alpaca**: free IEX feed — no explicit rate limit but use sparingly on historical calls
- **Finnhub**: 30 calls/second on free tier — the client throttles automatically
- **Anthropic**: news scoring is cached by article; the same headline is never scored twice
- **SEC EDGAR**: no API key required; uses User-Agent header per EDGAR guidelines

---

## Day Trading (Ross Cameron method)

The site is built around day trading. **Day Trade** is the home page (`/`) and **Next-Day Watchlist** is at `/watchlist`. Both stay running in the background when you switch pages. New BUY/READY setups or TOP watchlist names show as navbar badges, with optional desktop notifications. **Portfolio** shows live open positions and a trade journal with green/red P&L breakdowns. The Chart and AI Report tools from the original app are still in the nav.

### Day Trade

The **Day Trade** tab is a Webull-style scanner, chart and trade ticket built on Ross Cameron's (Warrior Trading) small-cap momentum rules. The rules are written up as a Claude skill in [.claude/skills/ross-cameron-day-trading/SKILL.md](.claude/skills/ross-cameron-day-trading/SKILL.md).

- **Scanner:** live US small-cap gainers graded against the Five Pillars (up ≥10%, ≥5x relative volume, fresh news, $2–$20, float <20M). A+ also needs up ≥30%, $5–$10, float <10M and 7–10 AM ET.
- **Today's game plan:** at the top of the scanner, the stocks most likely to hit your daily goal. PASSes are dropped, and the rest are ranked by live setup, grade, how realistic 2:1 is, how much of each trade's goal your cash can make, and catalyst. You get an alert with the picks at 7:00 AM and 9:30 AM ET.
- **Setup detection:** reads 1-minute bars (including pre-market) and labels each stock Extended, Pullback, Triggered, Broken or Stale, with entry at the first candle to make a new high, stop at the pullback low, and target at the high of day.
- **Your daily plan:** on first visit you set your real cash and how much you want to make per day, reached in 2 or 3 winning trades. Each trade is 2:1: a winner pays goal ÷ trades, and risk is half that. Max daily loss equals the goal. Shares = min(risk ÷ stop distance, buying power ÷ price). Ross's ¼-size start is optional.
- **CAD accounts:**
  - Cash, goal and P&L are in CAD. Every US trade converts at the live USD→CAD rate (or the rate your broker actually used).
  - Winners are sized to pay your goal in CAD, with an optional broker FX fee taken out of both legs.
  - Each trade's CAD P&L includes the FX move between buy and sell.
- **Live levels:** entry, stop and the 2:1 target recalculate from the chart every ~5 s. Typed levels stay frozen until you click "use live".
- **Real vs. paper:** the app never places orders. Recording a buy or sell asks whether it was a real order with your broker (and your actual fill price and shares) or a paper trade. Only real trades move your cash, and the 2:1 target is recomputed from your actual fill.
- **Session guard:** tells you to stop after the max loss, 3 losers in a row, or giving back half of the day's peak.
- **Market rail** on every page: indices plus small-cap, gainers, losers and most-active lists.

### Portfolio & trade journal

Buy and sell from the Day Trade ticket. Every position records a snapshot of the setup at entry: grade, verdict, chart state, float, price, catalyst, sector, market temperature and time. The Portfolio page shows:
- open positions with live prices, P&L, and stop/target hits
- account tiles: value, cash, open P&L, realized P&L, win rate, average win vs. average loss
- "What you're doing well" / "What's costing you" insights
- P&L bar charts by entry time, weekday, hold time, verdict, grade, setup, price, float, catalyst, market temperature, sector and ticker (each with a table view)

History: Day / Week / Month (with ← → to step back), 7D / 30D / 90D / YTD / All, or a custom date range. Click a bar in the Daily/Weekly P&L chart to drill into that day or week. The journal lives in the browser's localStorage (`sf_trade_journal`).

### Custom layouts

Day Trade and the Next-Day Watchlist are Webull-style widget grids. Click **⊞ Edit layout** in the top bar to:
- drag panels by their title bar
- resize panels from the right edge, bottom edge or corner
- hide or show panels from the Widgets bar
- reset the layout

Each page's layout is saved in the browser (`sf_layouts`). Built with `react-grid-layout`; it was installed with `--legacy-peer-deps` because of an existing ESLint peer conflict in this project.

### Settings

`/settings` holds everything you can change:
- your daily plan (cash, account type, goal, trades per goal, ¼-size rule)
- scanner defaults and game plan
- alerts
- starred watchlist
- Markets rail
- Portfolio defaults
- backup, restore and reset of your journal and settings

### Next-Day Watchlist

After-hours movers (4–8 PM ET), then pre-market gappers (4–9:30 AM), checked the way Ross builds his watchlist: the 5 pillars on the after-hours / pre-market move, how strong the close was, after-hours liquidity, buyouts (flat after a jump), pump risk for no-news foreign small caps, recent reverse splits and IPOs, spike-and-fade history, and the 200-day MA overhead. It also flags Monday/Friday and quarter-end. Starred stocks are pinned to the top of the Day Trade scanner the next morning.

Data comes from Yahoo Finance and Nasdaq.com market movers (no key needed), with Alpaca movers as a pre-market supplement. API: `GET /api/daytrade/scan`, `/api/daytrade/stock/{symbol}`, `/api/daytrade/bars/{symbol}`, `/api/daytrade/daily/{symbol}`, `/api/daytrade/watchlist`, `/api/daytrade/market`.
