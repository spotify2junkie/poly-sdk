#!/usr/bin/env tsx
/**
 * TUI Trading Bot - Terminal UI with Blessed (REAL DATA)
 *
 * Features:
 * - Top: Header with mode and PnL
 * - Middle: Signal boxes for BTC/ETH (orange border)
 * - Bottom: Order books for BTC/ETH
 * - Real-time updates from Polymarket WebSocket
 *
 * Usage:
 *   pnpm exec tsx examples/tui-trading-bot.ts
 */

import 'dotenv/config';
import { PolymarketSDK } from '../src/index.js';
import type { OrderbookSnapshot } from '../src/services/realtime-service-v2.js';
import blessed from 'blessed';

// ===== Configuration =====
const ENTRY_MIN = parseFloat(process.env.ENTRY_MIN || '0.10');
const ENTRY_MAX = parseFloat(process.env.ENTRY_MAX || '0.25');
const DRY_RUN = process.env.DRY_RUN !== 'false';

// ===== Types =====
interface MarketData {
  token: 'BTC' | 'ETH';
  question: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  endTime: number;
  yesPrice: number;
  noPrice: number;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  inRange: boolean;
  lastUpdate: number;
}

interface Trade {
  token: 'BTC' | 'ETH';
  side: 'UP' | 'DOWN';
  entryPrice: number;
  exitPrice?: number;
  size: number;
  pnl: number;
  timestamp: number;
}

// ===== State =====
const state: {
  markets: {
    btc: MarketData | null;
    eth: MarketData | null;
  };
  sdk: PolymarketSDK | null;
  updateCounts: {
    btc: number;
    eth: number;
  };
  subscriptions: {
    btc: { yes: string; no: string; subscription: { unsubscribe: () => void } } | null;
    eth: { yes: string; no: string; subscription: { unsubscribe: () => void } } | null;
  };
  trades: Trade[];
  totalPnl: number;
  timers: {
    refreshCheck: NodeJS.Timeout | null;
    uiUpdate: NodeJS.Timeout | null;
  };
} = {
  markets: { btc: null, eth: null },
  sdk: null,
  updateCounts: { btc: 0, eth: 0 },
  subscriptions: { btc: null, eth: null },
  trades: [],
  totalPnl: 0,
  timers: { refreshCheck: null, uiUpdate: null },
};

// ===== Blessed Screen Setup =====
const screen = blessed.screen({
  smartCSR: true,
  title: 'Polymarket Trading Bot',
  fullUnicode: true,
});

// Theme colors
const colors = {
  bg: '#1a1a2e',
  fg: '#eee',
  green: '#00ff00',
  red: '#ff4444',
  orange: '#ff9800',
  yellow: '#ffeb3b',
  cyan: '#00bcd4',
  magenta: '#ff00ff',
};

// ===== Components =====

// Header box (top row, spans full width)
const headerBox = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: '100%',
  height: 4,
  tags: true,
  style: { bg: colors.bg, fg: colors.fg },
  border: { type: 'line' },
});

// PnL box (right side of header area)
const pnlBox = blessed.box({
  parent: screen,
  top: 0,
  right: 0,
  width: 30,
  height: 4,
  label: ' {bold}{magenta-fg}💰 WALLET PnL{/bold} ',
  tags: true,
  border: { type: 'line', fg: colors.magenta },
  style: {
    bg: colors.bg,
    fg: colors.fg,
    border: { fg: colors.magenta },
  },
});

// BTC Signal box
const btcSignalBox = blessed.box({
  parent: screen,
  top: 5,
  left: 0,
  width: '50%',
  height: 9,
  label: ' {bold}{yellow-fg}⚡ BTC SIGNAL{/bold} ',
  tags: true,
  border: { type: 'line', fg: colors.orange },
  style: {
    bg: colors.bg,
    fg: colors.fg,
    border: { fg: colors.orange },
  },
});

// ETH Signal box
const ethSignalBox = blessed.box({
  parent: screen,
  top: 5,
  left: '50%',
  width: '50%',
  height: 9,
  label: ' {bold}{yellow-fg}⚡ ETH SIGNAL{/bold} ',
  tags: true,
  border: { type: 'line', fg: colors.orange },
  style: {
    bg: colors.bg,
    fg: colors.fg,
    border: { fg: colors.orange },
  },
});

// BTC Order Book box
const btcOrderBookBox = blessed.box({
  parent: screen,
  top: 15,
  left: 0,
  width: '50%',
  height: '100%-19',
  label: ' {bold}{cyan-fg}📖 BTC ORDERS{/bold} ',
  tags: true,
  border: { type: 'line', fg: colors.cyan },
  style: {
    bg: colors.bg,
    fg: colors.fg,
    border: { fg: colors.cyan },
  },
});

// ETH Order Book box
const ethOrderBookBox = blessed.box({
  parent: screen,
  top: 15,
  left: '50%',
  width: '50%',
  height: '100%-19',
  label: ' {bold}{cyan-fg}📖 ETH ORDERS{/bold} ',
  tags: true,
  border: { type: 'line', fg: colors.cyan },
  style: {
    bg: colors.bg,
    fg: colors.fg,
    border: { fg: colors.cyan },
  },
});

// Status bar
const statusBar = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: '100%',
  height: 2,
  tags: true,
  style: { bg: '#16213e', fg: colors.fg },
});

// ===== Update Functions =====

function formatTimeRemaining(endTime: number): string {
  const remaining = Math.max(0, endTime - Date.now());
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return `{yellow-fg}${minutes}:${seconds.toString().padStart(2, '0')}{/yellow-fg}`;
}

function getConnectionStatus(lastUpdate: number): string {
  const ago = Date.now() - lastUpdate;
  if (ago < 5000) return '{green-fg}● Live{/green-fg}';
  if (ago < 30000) return '{yellow-fg}● Stale{/yellow-fg}';
  return '{red-fg}● No Data{/red-fg}';
}

function updateHeader() {
  const modeStr = DRY_RUN ?
    '{yellow-fg}[DRY-RUN]{/yellow-fg}' :
    '{red-fg}[TRADING]{/red-fg}';

  const pnlColor = state.totalPnl >= 0 ? '{green-fg}' : '{red-fg}';
  const pnlSign = state.totalPnl >= 0 ? '+' : '';

  headerBox.setContent(
    `{center}{bold}{green-fg}POLYMARKET TRADING BOT{/green-fg}{/bold}\n` +
    `{center}${modeStr}  Entry: ${(ENTRY_MIN * 100).toFixed(0)}-${(ENTRY_MAX * 100).toFixed(0)}%  {bold}Trades:{/bold} ${state.trades.length}\n` +
    `{center}{dim}Press {yellow-fg}q{/yellow-fg} to exit{/dim}`
  );
}

function updatePnlBox() {
  const isProfit = state.totalPnl >= 0;
  const pnlSign = isProfit ? '+' : '';

  let content = '';
  if (isProfit) {
    content += `{bold}Total PnL:{/bold} {green-fg}$${pnlSign}${state.totalPnl.toFixed(2)}{/green-fg}\n`;
  } else {
    content += `{bold}Total PnL:{/bold} {red-fg}$${pnlSign}${state.totalPnl.toFixed(2)}{/red-fg}\n`;
  }
  content += `{bold}Trades:{/bold} ${state.trades.length}\n`;

  if (state.trades.length > 0) {
    const lastTrade = state.trades[state.trades.length - 1];
    if (lastTrade.pnl >= 0) {
      content += `{dim}Last: ${lastTrade.token} ${lastTrade.side} {green-fg}$+${lastTrade.pnl.toFixed(2)}{/green-fg}{/dim}`;
    } else {
      content += `{dim}Last: ${lastTrade.token} ${lastTrade.side} {red-fg}$${lastTrade.pnl.toFixed(2)}{/red-fg}{/dim}`;
    }
  } else {
    content += '{dim}No trades yet{/dim}';
  }

  pnlBox.setContent(content);
}

function updateSignalBox(box: typeof btcSignalBox, market: MarketData | null, token: 'BTC' | 'ETH') {
  if (!market) {
    box.setContent(`{bold}{red-fg}Loading ${token}...{/red-fg}{/bold}`);
    return;
  }

  const timeStr = formatTimeRemaining(market.endTime);
  const statusStr = getConnectionStatus(market.lastUpdate);
  const inRange = market.inRange;
  const yesPrice = (market.yesPrice * 100).toFixed(1);
  const noPrice = (market.noPrice * 100).toFixed(1);
  const updateNum = state.updateCounts[token.toLowerCase() as 'btc' | 'eth'];
  const timeStr2 = new Date(market.lastUpdate).toLocaleTimeString();

  // Check if market needs refresh soon
  const timeLeft = market.endTime - Date.now();
  const refreshWarning = timeLeft < 60000 ? `{yellow-fg} [REFRESHING SOON]{/yellow-fg}` : '';

  let rangeStr = '';
  if (inRange) {
    rangeStr = `{green-fg}▲ ENTRY{/green-fg} (${(ENTRY_MIN * 100).toFixed(0)}-${(ENTRY_MAX * 100).toFixed(0)}%)`;
  } else {
    rangeStr = `{red-fg}▼ OUT RANGE{/red-fg} (${(ENTRY_MIN * 100).toFixed(0)}-${(ENTRY_MAX * 100).toFixed(0)}%)`;
  }

  const content =
    `{bold}${token}{/bold}${refreshWarning}\n` +
    `Time: ${timeStr}  ${statusStr}\n` +
    `UP: {green-fg}${yesPrice}%{/green-fg}  DOWN: {red-fg}${noPrice}%{/red-fg}\n` +
    `${rangeStr}\n` +
    `{dim}Updates: #${updateNum}{/dim}\n` +
    `{dim}${timeStr2}{/dim}`;

  box.setContent(content);
}

function updateOrderBook(box: typeof btcOrderBookBox, market: MarketData | null, token: 'BTC' | 'ETH') {
  if (!market) {
    box.setContent(`{bold}{red-fg}Loading ${token}...{/red-fg}{/bold}`);
    return;
  }

  const hasData = market.bids.length > 0 || market.asks.length > 0;
  const updateNum = state.updateCounts[token.toLowerCase() as 'btc' | 'eth'];

  if (!hasData) {
    const content = `{dim}Waiting for data...{/dim}\n{dim}Updates: #${updateNum}{/dim}`;
    box.setContent(content);
    return;
  }

  let content = '{bold}  Price    Vol    Side{/bold}\n';

  // Bids (UP orders)
  for (const bid of market.bids.slice(0, 5)) {
    const price = (bid.price * 100).toFixed(1);
    const size = bid.size.toFixed(0).padStart(5);
    content += `  {green-fg}${price}%{/green-fg}   ${size}  {green-fg}UP{/green-fg}\n`;
  }

  content += '{dim}  ─────────────────{/dim}\n';

  // Asks (DOWN orders)
  for (const ask of market.asks.slice(0, 5)) {
    const downPrice = ((1 - ask.price) * 100).toFixed(1);
    const size = ask.size.toFixed(0).padStart(5);
    content += `  {red-fg}${downPrice}%{/red-fg}   ${size}  {red-fg}DOWN{/red-fg}\n`;
  }

  box.setContent(content);
}

function updateStatusBar() {
  const btcStatus = state.markets.btc ? getConnectionStatus(state.markets.btc.lastUpdate) : '{red-fg}Loading{/red-fg}';
  const ethStatus = state.markets.eth ? getConnectionStatus(state.markets.eth.lastUpdate) : '{red-fg}Loading{/red-fg}';
  const modeStr = DRY_RUN ? '{yellow-fg}[DRY-RUN]{/yellow-fg}' : '{red-fg}[TRADING]{/red-fg}';
  const content = `${modeStr}  BTC: ${btcStatus}  ETH: ${ethStatus}  {bold}q{/bold}=exit`;
  statusBar.setContent(content);
}

// ===== Render Throttling (P1-002 fix) =====
let renderScheduled = false;
let renderTimer: NodeJS.Timeout | null = null;

function scheduleRender() {
  if (renderScheduled) return; // Already scheduled

  renderScheduled = true;

  if (renderTimer) {
    clearTimeout(renderTimer);
  }

  renderTimer = setTimeout(() => {
    screen.render();
    renderScheduled = false;
    renderTimer = null;
  }, 50); // Max 20 renders/second
}

// ===== Market Discovery =====
async function discoverMarket(token: 'btc' | 'eth'): Promise<MarketData | null> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / 900) * 900;

    for (let offset = 0; offset <= 2; offset++) {
      const timestamp = windowStart + (offset * 900);
      const expectedSlug = `${token}-updown-15m-${timestamp}`;

      const response = await fetch(`https://gamma-api.polymarket.com/markets?slug=${expectedSlug}`);
      const data = await response.json();

      if (data?.[0]) {
        const market = data[0];
        const endDate = new Date(market.endDate);
        const timeUntilExpiry = (endDate.getTime() - Date.now()) / 1000;

        if (market.active && timeUntilExpiry > 60) {
          const tokenIds = JSON.parse(market.clobTokenIds || '[]');
          if (tokenIds.length >= 2) {
            return {
              token: token.toUpperCase() as 'BTC' | 'ETH',
              question: market.question,
              conditionId: market.conditionId,
              yesTokenId: tokenIds[0],
              noTokenId: tokenIds[1],
              endTime: endDate.getTime(),
              yesPrice: 0.5,
              noPrice: 0.5,
              bids: [],
              asks: [],
              inRange: false,
              lastUpdate: Date.now(),
            };
          }
        }
      }
    }
    return null;
  } catch (error) {
    console.error(`✗ ${token.toUpperCase()} discovery failed:`, (error as Error).message);
    return null;
  }
}

// ===== Market Refresh =====
function needsRefresh(market: MarketData | null): boolean {
  if (!market) return false;
  const timeLeft = market.endTime - Date.now();
  return timeLeft < 30000; // Refresh if less than 30 seconds left
}

async function refreshMarket(token: 'btc' | 'eth'): Promise<boolean> {
  const sdk = state.sdk;
  if (!sdk) return false;

  const oldMarket = state.markets[token];
  if (!oldMarket) return false;

  console.log(`🔄 Refreshing ${token.toUpperCase()} market...`);

  // Discover new market
  const newMarket = await discoverMarket(token);
  if (!newMarket) {
    console.log(`⚠️  No new ${token.toUpperCase()} market found`);
    return false;
  }

  // Check if it's actually a different market (newer end time)
  if (newMarket.endTime <= oldMarket.endTime) {
    return false; // Same market or older, no need to refresh
  }

  const tokenKey = token as 'btc' | 'eth';

  // P1-001: Clean up old subscription before creating new one
  const oldSubscription = state.subscriptions[tokenKey];
  if (oldSubscription?.subscription) {
    oldSubscription.subscription.unsubscribe();
    state.subscriptions[tokenKey] = null;
  }

  // Update state with new market
  state.markets[tokenKey] = newMarket;
  state.updateCounts[tokenKey] = 0;

  // Re-subscribe to new market and store subscription object
  const subscription = sdk.realtime.subscribeMarket(
    newMarket.yesTokenId,
    newMarket.noTokenId,
    {
      onOrderbook: (book) => {
        processOrderbook(book, newMarket);
      },
      onError: (error) => {
        console.error(`❌ ${token.toUpperCase()}: ${error.message}`);
      },
    }
  );

  state.subscriptions[tokenKey] = {
    yes: newMarket.yesTokenId,
    no: newMarket.noTokenId,
    subscription,
  };

  console.log(`✓ ${token.toUpperCase()} switched to new market (ends ${new Date(newMarket.endTime).toLocaleTimeString()})`);

  // Update UI
  if (token === 'btc') {
    updateSignalBox(btcSignalBox, newMarket, 'BTC');
    updateOrderBook(btcOrderBookBox, newMarket, 'BTC');
  } else {
    updateSignalBox(ethSignalBox, newMarket, 'ETH');
    updateOrderBook(ethOrderBookBox, newMarket, 'ETH');
  }

  updateStatusBar();
  scheduleRender(); // P1-002: Use throttled render

  return true;
}

// ===== Orderbook Processing =====
function processOrderbook(book: OrderbookSnapshot, market: MarketData) {
  market.lastUpdate = Date.now();

  const bids: Array<{ price: number; size: number }> = [];
  const asks: Array<{ price: number; size: number }> = [];

  for (const bid of book.bids.slice(0, 10)) {
    bids.push({ price: bid.price, size: bid.size });
  }

  for (const ask of book.asks.slice(0, 10)) {
    asks.push({ price: ask.price, size: ask.size });
  }

  market.bids = bids;
  market.asks = asks;

  const midPrice = book.bids[0]?.price || book.asks[0]?.price || 0;

  if (midPrice > 0) {
    market.yesPrice = midPrice;
    market.noPrice = 1 - midPrice;
    market.inRange = midPrice >= ENTRY_MIN && midPrice <= ENTRY_MAX;
  }

  const tokenKey = market.token.toLowerCase() as 'btc' | 'eth';
  state.updateCounts[tokenKey]++;
  const count = state.updateCounts[tokenKey];

  // Only log first connection
  if (count === 1 && bids.length > 0) {
    console.log(`✓ ${market.token}: Connected`);
  }

  // Update UI
  if (market.token === 'BTC') {
    updateSignalBox(btcSignalBox, market, 'BTC');
    updateOrderBook(btcOrderBookBox, market, 'BTC');
  } else {
    updateSignalBox(ethSignalBox, market, 'ETH');
    updateOrderBook(ethOrderBookBox, market, 'ETH');
  }

  updateStatusBar();
  scheduleRender(); // P1-002: Use throttled render instead of direct screen.render()
}

// ===== Main =====
async function main(): Promise<void> {
  updateHeader();
  updatePnlBox();
  screen.render();

  // P1-001 + P1-003: Cleanup handler for subscriptions and timers
  const cleanup = () => {
    // Clear all timers
    if (state.timers.refreshCheck) {
      clearInterval(state.timers.refreshCheck);
      state.timers.refreshCheck = null;
    }
    if (state.timers.uiUpdate) {
      clearInterval(state.timers.uiUpdate);
      state.timers.uiUpdate = null;
    }
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }

    // Unsubscribe from all markets
    state.subscriptions.btc?.subscription.unsubscribe();
    state.subscriptions.eth?.subscription.unsubscribe();

    // Disconnect WebSocket
    state.sdk?.realtime.disconnect();
  };

  screen.key(['q', 'C-c'], () => {
    cleanup();
    process.exit(0);
  });

  const sdk = new PolymarketSDK();
  state.sdk = sdk;

  // Discover markets (quiet)
  const [btcMarket, ethMarket] = await Promise.all([
    discoverMarket('btc'),
    discoverMarket('eth'),
  ]);

  if (!btcMarket || !ethMarket) {
    console.error('✗ Failed to discover markets');
    process.exit(1);
  }

  state.markets.btc = btcMarket;
  state.markets.eth = ethMarket;

  // Initial render
  updateSignalBox(btcSignalBox, btcMarket, 'BTC');
  updateSignalBox(ethSignalBox, ethMarket, 'ETH');
  updateOrderBook(btcOrderBookBox, btcMarket, 'BTC');
  updateOrderBook(ethOrderBookBox, ethMarket, 'ETH');
  updateStatusBar();
  screen.render();

  // Connect to WebSocket
  sdk.realtime.connect();

  sdk.realtime.on('connected', () => {
    // P1-001: Track and subscribe to BTC with subscription object
    const btcSubscription = sdk.realtime.subscribeMarket(
      btcMarket.yesTokenId,
      btcMarket.noTokenId,
      {
        onOrderbook: (book) => {
          processOrderbook(book, btcMarket);
        },
        onError: (error) => {
          console.error(`❌ BTC: ${error.message}`);
        },
      }
    );
    state.subscriptions.btc = {
      yes: btcMarket.yesTokenId,
      no: btcMarket.noTokenId,
      subscription: btcSubscription,
    };

    // P1-001: Track and subscribe to ETH with subscription object
    const ethSubscription = sdk.realtime.subscribeMarket(
      ethMarket.yesTokenId,
      ethMarket.noTokenId,
      {
        onOrderbook: (book) => {
          processOrderbook(book, ethMarket);
        },
        onError: (error) => {
          console.error(`❌ ETH: ${error.message}`);
        },
      }
    );
    state.subscriptions.eth = {
      yes: ethMarket.yesTokenId,
      no: ethMarket.noTokenId,
      subscription: ethSubscription,
    };
  });

  sdk.realtime.on('disconnected', () => {
    // Silent reconnect
  });

  // P1-003: Track timer and check for market refresh every 5 seconds
  state.timers.refreshCheck = setInterval(async () => {
    if (needsRefresh(state.markets.btc)) {
      await refreshMarket('btc');
    }
    if (needsRefresh(state.markets.eth)) {
      await refreshMarket('eth');
    }
  }, 5000);

  // P1-003: Track timer and update UI every second
  state.timers.uiUpdate = setInterval(() => {
    if (state.markets.btc) {
      updateSignalBox(btcSignalBox, state.markets.btc, 'BTC');
    }
    if (state.markets.eth) {
      updateSignalBox(ethSignalBox, state.markets.eth, 'ETH');
    }
    updatePnlBox();
    updateStatusBar();
    scheduleRender(); // P1-002: Use throttled render
  }, 1000);

  screen.render();
}

main().catch(console.error);
