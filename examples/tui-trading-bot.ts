#!/usr/bin/env tsx
/**
 * TUI Trading Bot - Terminal UI with Blessed (REAL DATA + TRADING)
 *
 * Features:
 * - Top: Header with mode and PnL
 * - Middle: Signal boxes for BTC/ETH (orange border)
 * - Bottom: Order books for BTC/ETH
 * - Real-time updates from Polymarket WebSocket
 * - AUTOMATIC TRADING: Entry, sizing, exit logic
 *
 * Usage:
 *   pnpm exec tsx examples/tui-trading-bot.ts
 *
 * Environment Variables:
 *   ENTRY_MIN=0.10       - Minimum price to enter (default 10%)
 *   ENTRY_MAX=0.25       - Maximum price to enter (default 25%)
 *   POSITION_SIZE=10     - Position size in USDC (default 10)
 *   TAKE_PROFIT=0.05     - Take profit at 5% price move (default 0.05)
 *   STOP_LOSS=0.03       - Stop loss at 3% price move (default 0.03)
 *   MAX_POSITION_TIME=10 - Max minutes to hold position (default 10)
 *   DRY_RUN=true         - Set to 'false' for live trading
 */

import 'dotenv/config';
import { PolymarketSDK } from '../src/index.js';
import type { OrderbookSnapshot } from '../src/services/realtime-service-v2.js';
import blessed from 'blessed';

// ===== Configuration =====
const ENTRY_MIN = parseFloat(process.env.ENTRY_MIN || '0.10');
const ENTRY_MAX = parseFloat(process.env.ENTRY_MAX || '0.25');
const POSITION_SIZE = parseFloat(process.env.POSITION_SIZE || '10');
const TAKE_PROFIT = parseFloat(process.env.TAKE_PROFIT || '0.05');
const STOP_LOSS = parseFloat(process.env.STOP_LOSS || '0.03');
const MAX_POSITION_TIME = parseInt(process.env.MAX_POSITION_TIME || '10') * 60 * 1000; // minutes to ms
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

interface Position {
  id: string;
  token: 'BTC' | 'ETH';
  side: 'UP' | 'DOWN';
  entryPrice: number;
  size: number;
  sizeUsdc: number;
  timestamp: number;
  exitPrice?: number;
  exitReason?: string;
  pnl?: number;
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
  positions: {
    btc: Position | null;
    eth: Position | null;
  };
  trades: Trade[];
  totalPnl: number;
  timers: {
    refreshCheck: NodeJS.Timeout | null;
    uiUpdate: NodeJS.Timeout | null;
    positionCheck: NodeJS.Timeout | null;
  };
  // Track last entry time to prevent duplicate entries
  lastEntryTime: {
    btc: number;
    eth: number;
  };
} = {
  markets: { btc: null, eth: null },
  sdk: null,
  updateCounts: { btc: 0, eth: 0 },
  subscriptions: { btc: null, eth: null },
  positions: { btc: null, eth: null },
  trades: [],
  totalPnl: 0,
  timers: { refreshCheck: null, uiUpdate: null, positionCheck: null },
  lastEntryTime: { btc: 0, eth: 0 },
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
  blue: '#2196f3',
};

// ===== Components =====

// Header box
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

// PnL box
const pnlBox = blessed.box({
  parent: screen,
  top: 0,
  right: 0,
  width: 35,
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

// BTC Position box (NEW)
const btcPositionBox = blessed.box({
  parent: screen,
  top: 5,
  left: 0,
  width: '50%',
  height: 7,
  label: ' {bold}{blue-fg}📊 BTC POSITION{/bold} ',
  tags: true,
  border: { type: 'line', fg: colors.blue },
  style: {
    bg: colors.bg,
    fg: colors.fg,
    border: { fg: colors.blue },
  },
});

// ETH Position box (NEW)
const ethPositionBox = blessed.box({
  parent: screen,
  top: 5,
  left: '50%',
  width: '50%',
  height: 7,
  label: ' {bold}{blue-fg}📊 ETH POSITION{/bold} ',
  tags: true,
  border: { type: 'line', fg: colors.blue },
  style: {
    bg: colors.bg,
    fg: colors.fg,
    border: { fg: colors.blue },
  },
});

// BTC Order Book box
const btcOrderBookBox = blessed.box({
  parent: screen,
  top: 13,
  left: 0,
  width: '50%',
  height: '100%-17',
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
  top: 13,
  left: '50%',
  width: '50%',
  height: '100%-17',
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

  const activePositions = (state.positions.btc ? 1 : 0) + (state.positions.eth ? 1 : 0);

  headerBox.setContent(
    `{center}{bold}{green-fg}POLYMARKET TRADING BOT{/green-fg}{/bold}\n` +
    `{center}${modeStr}  Entry: ${(ENTRY_MIN * 100).toFixed(0)}-${(ENTRY_MAX * 100).toFixed(0)}%  Pos: $${POSITION_SIZE}  TP: ${(TAKE_PROFIT * 100).toFixed(0)}%  SL: ${(STOP_LOSS * 100).toFixed(0)}%\n` +
    `{center}{dim}Active: ${activePositions}  Trades: ${state.trades.length}{/dim}  {dim}Press {yellow-fg}q{/yellow-fg} to exit{/dim}`
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
    const lastPnlSign = lastTrade.pnl >= 0 ? '+' : '';
    if (lastTrade.pnl >= 0) {
      content += `{dim}Last: ${lastTrade.token} ${lastTrade.side} {green-fg}$${lastPnlSign}${lastTrade.pnl.toFixed(2)}{/green-fg}{/dim}`;
    } else {
      content += `{dim}Last: ${lastTrade.token} ${lastTrade.side} {red-fg}$${lastPnlSign}${lastTrade.pnl.toFixed(2)}{/red-fg}{/dim}`;
    }
  } else {
    content += '{dim}No trades yet{/dim}';
  }

  pnlBox.setContent(content);
}

function updatePositionBox(box: typeof btcPositionBox, position: Position | null, token: 'BTC' | 'ETH') {
  if (!position) {
    box.setContent(`{dim}No ${token} position{/dim}`);
    return;
  }

  const holdTime = Date.now() - position.timestamp;
  const holdTimeSec = (holdTime / 1000).toFixed(0);
  const maxTimeSec = (MAX_POSITION_TIME / 1000).toFixed(0);

  const currentPrice = position.side === 'UP' ? state.markets[token.toLowerCase() as 'btc' | 'eth']?.yesPrice : state.markets[token.toLowerCase() as 'btc' | 'eth']?.noPrice;
  const currentPriceNum = currentPrice || position.entryPrice;

  // Calculate unrealized PnL
  let unrealizedPnl = 0;
  if (position.side === 'UP') {
    unrealizedPnl = (currentPriceNum - position.entryPrice) * position.size;
  } else {
    // DOWN: profit when price drops
    const priceChange = position.entryPrice - currentPriceNum;
    unrealizedPnl = priceChange * position.size;
  }

  const pnlSign = unrealizedPnl >= 0 ? '+' : '';
  const pnlColor = unrealizedPnl >= 0 ? 'green-fg' : 'red-fg';
  const sideColor = position.side === 'UP' ? 'green-fg' : 'red-fg';

  const content =
    `{bold}${position.side} ${token}{/bold} {${sideColor}}$${position.sizeUsdc.toFixed(2)}{/${sideColor}}\n` +
    `Entry: ${(position.entryPrice * 100).toFixed(1)}%  Now: ${(currentPriceNum * 100).toFixed(1)}%\n` +
    `PnL: {${pnlColor}}$${pnlSign}${unrealizedPnl.toFixed(2)}{/${pnlColor}}  Time: ${holdTimeSec}s/${maxTimeSec}s\n` +
    `{dim}ID: ${position.id.slice(0, 8)}...{/dim}`;

  box.setContent(content);
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

  // Check if market needs refresh soon
  const timeLeft = market.endTime - Date.now();
  const refreshWarning = timeLeft < 60000 ? `{yellow-fg} [REFRESHING SOON]{/yellow-fg}` : '';

  let rangeStr = '';
  if (inRange) {
    rangeStr = `{green-fg}▲ ENTRY SIGNAL{/green-fg} (${(ENTRY_MIN * 100).toFixed(0)}-${(ENTRY_MAX * 100).toFixed(0)}%)`;
  } else {
    rangeStr = `{red-fg}▼ WAITING FOR RANGE{/red-fg} (${(ENTRY_MIN * 100).toFixed(0)}-${(ENTRY_MAX * 100).toFixed(0)}%)`;
  }

  const content =
    `{bold}${token}{/bold}${refreshWarning}\n` +
    `Time: ${timeStr}  ${statusStr}\n` +
    `UP: {green-fg}${yesPrice}%{/green-fg}  DOWN: {red-fg}${noPrice}%{/red-fg}\n` +
    `${rangeStr}\n` +
    `{dim}Updates: #${updateNum}{/dim}`;

  box.setContent(content);
}

function updateOrderBook(box: typeof btcOrderBookBox, market: MarketData | null, token: 'BTC' | 'ETH') {
  if (!market) {
    box.setContent(`{bold}{red-fg}Loading ${token}...{/red-fg}{/bold}`);
    return;
  }

  const hasData = market.bids.length > 0 || market.asks.length > 0;

  if (!hasData) {
    const content = `{dim}Waiting for orderbook data...{/dim}`;
    box.setContent(content);
    return;
  }

  let content = '{bold}  Price    Vol    Side{/bold}\n';

  // Bids (UP orders)
  for (const bid of market.bids.slice(0, 4)) {
    const price = (bid.price * 100).toFixed(1);
    const size = bid.size.toFixed(0).padStart(5);
    content += `  {green-fg}${price}%{/green-fg}   ${size}  {green-fg}UP{/green-fg}\n`;
  }

  content += '{dim}  ─────────────────{/dim}\n';

  // Asks (DOWN orders) - convert to DOWN price
  for (const ask of market.asks.slice(0, 4)) {
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

// ===== Render Throttling =====
let renderScheduled = false;
let renderTimer: NodeJS.Timeout | null = null;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    screen.render();
    renderScheduled = false;
    renderTimer = null;
  }, 50);
}

// ===== Trading Functions =====

/**
 * Check if we should enter a position
 */
function shouldEnterPosition(market: MarketData): 'UP' | 'DOWN' | null {
  if (!market.inRange) return null;

  const tokenKey = market.token.toLowerCase() as 'btc' | 'eth';

  // Check if we already have a position for this token
  if (state.positions[tokenKey]) {
    return null;
  }

  // Debounce: Don't enter if we entered within last 5 seconds
  const timeSinceLastEntry = Date.now() - state.lastEntryTime[tokenKey];
  if (timeSinceLastEntry < 5000) {
    return null;
  }

  // Decide UP or DOWN based on price position in range
  const midRange = (ENTRY_MIN + ENTRY_MAX) / 2;
  if (market.yesPrice < midRange) {
    return 'UP'; // Price is low, buy UP
  } else if (market.yesPrice > midRange) {
    return 'DOWN'; // Price is high, buy DOWN (which bets price will go down)
  }

  // At exact middle, don't enter
  return null;
}

/**
 * Enter a position
 */
async function enterPosition(market: MarketData, side: 'UP' | 'DOWN'): Promise<void> {
  const tokenKey = market.token.toLowerCase() as 'btc' | 'eth';

  // Double-check no position exists (prevent race condition)
  if (state.positions[tokenKey]) {
    return;
  }

  // Update last entry time immediately to prevent duplicate entries
  state.lastEntryTime[tokenKey] = Date.now();

  // Calculate position size
  const entryPrice = side === 'UP' ? market.yesPrice : market.noPrice;
  const size = POSITION_SIZE / entryPrice; // Number of shares

  const position: Position = {
    id: `${market.token}-${Date.now()}`,
    token: market.token,
    side,
    entryPrice,
    size,
    sizeUsdc: POSITION_SIZE,
    timestamp: Date.now(),
  };

  // Store position
  state.positions[tokenKey] = position;

  // Log the entry
  console.log(`📈 ${DRY_RUN ? '[DRY-RUN] ' : ''}${market.token} ${side} ENTRY`);
  console.log(`   Price: ${(entryPrice * 100).toFixed(1)}%  Size: ${size.toFixed(2)} shares ($${POSITION_SIZE.toFixed(2)})`);

  // If not dry run, place the actual order
  if (!DRY_RUN && state.sdk) {
    try {
      const tokenId = side === 'UP' ? market.yesTokenId : market.noTokenId;
      const result = await state.sdk.tradingService.createMarketOrder({
        tokenId,
        side: 'BUY',
        amount: size,
      });

      if (result.success) {
        console.log(`   ✓ Order placed: ${result.orderId || result.orderIds?.join(', ')}`);
      } else {
        // Better error handling
        const errorMsg = result.errorMsg || (typeof result === 'object' ? JSON.stringify(result).slice(0, 100) : 'Unknown error');
        console.error(`   ✗ Order failed: ${errorMsg}`);
        // Remove position if order failed
        state.positions[tokenKey] = null;
        // Reset entry time so we can try again
        state.lastEntryTime[tokenKey] = 0;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Check for Cloudflare block
      if (errorMsg.includes('403') || errorMsg.includes('Cloudflare')) {
        console.error(`   ✗ Order blocked by Cloudflare (IP may be rate limited)`);
      } else {
        console.error(`   ✗ Order error: ${errorMsg}`);
      }
      // Remove position if order failed
      state.positions[tokenKey] = null;
      // Reset entry time so we can try again
      state.lastEntryTime[tokenKey] = 0;
    }
  }

  // Update UI
  updatePositionBox(market.token === 'BTC' ? btcPositionBox : ethPositionBox, position, market.token);
  scheduleRender();
}

/**
 * Check if we should exit a position
 */
function shouldExitPosition(position: Position, market: MarketData): { shouldExit: boolean; reason?: string } {
  const currentPrice = position.side === 'UP' ? market.yesPrice : market.noPrice;

  // Calculate price change
  let priceChange: number;
  if (position.side === 'UP') {
    priceChange = currentPrice - position.entryPrice;
  } else {
    // DOWN position: profit when price goes DOWN
    priceChange = position.entryPrice - currentPrice;
  }

  // Take profit
  if (priceChange >= TAKE_PROFIT) {
    return { shouldExit: true, reason: 'TAKE_PROFIT' };
  }

  // Stop loss
  if (priceChange <= -STOP_LOSS) {
    return { shouldExit: true, reason: 'STOP_LOSS' };
  }

  // Time-based exit
  const holdTime = Date.now() - position.timestamp;
  if (holdTime >= MAX_POSITION_TIME) {
    return { shouldExit: true, reason: 'TIME_EXIT' };
  }

  return { shouldExit: false };
}

/**
 * Exit a position
 */
async function exitPosition(position: Position, reason: string): Promise<void> {
  const tokenKey = position.token.toLowerCase() as 'btc' | 'eth';
  const market = state.markets[tokenKey];
  if (!market) return;

  const exitPrice = position.side === 'UP' ? market.yesPrice : market.noPrice;

  // Calculate PnL
  let pnl: number;
  if (position.side === 'UP') {
    pnl = (exitPrice - position.entryPrice) * position.size;
  } else {
    // DOWN position
    pnl = (position.entryPrice - exitPrice) * position.size;
  }

  // Update position with exit info
  position.exitPrice = exitPrice;
  position.exitReason = reason;
  position.pnl = pnl;

  // Add to trades
  const trade: Trade = {
    token: position.token,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    size: position.size,
    pnl,
    timestamp: Date.now(),
  };
  state.trades.push(trade);

  // Update total PnL
  state.totalPnl += pnl;

  // Log the exit
  const pnlSign = pnl >= 0 ? '+' : '';
  const pnlColor = pnl >= 0 ? '✓' : '✗';
  console.log(`${pnlColor} ${DRY_RUN ? '[DRY-RUN] ' : ''}${position.token} ${position.side} EXIT (${reason})`);
  console.log(`   Entry: ${(position.entryPrice * 100).toFixed(1)}%  Exit: ${(exitPrice * 100).toFixed(1)}%`);
  console.log(`   PnL: ${pnlSign}$${pnl.toFixed(2)}`);

  // If not dry run, place the exit order (sell)
  if (!DRY_RUN && state.sdk) {
    try {
      // Get correct token ID from market data
      const tokenId = position.side === 'UP' ? market.yesTokenId : market.noTokenId;

      const result = await state.sdk.tradingService.createMarketOrder({
        tokenId,
        side: 'SELL',
        amount: position.size,
      });

      if (result.success) {
        console.log(`   ✓ Exit order placed: ${result.orderId || result.orderIds?.join(', ')}`);
      } else {
        const errorMsg = result.errorMsg || (typeof result === 'object' ? JSON.stringify(result).slice(0, 100) : 'Unknown error');
        console.error(`   ✗ Exit order failed: ${errorMsg}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes('403') || errorMsg.includes('Cloudflare')) {
        console.error(`   ✗ Exit order blocked by Cloudflare (IP may be rate limited)`);
      } else {
        console.error(`   ✗ Exit order error: ${errorMsg}`);
      }
    }
  }

  // Clear position
  state.positions[tokenKey] = null;

  // Update UI
  updatePositionBox(position.token === 'BTC' ? btcPositionBox : ethPositionBox, null, position.token);
  updatePnlBox();
  updateHeader();
  scheduleRender();
}

/**
 * Check all positions for exit conditions
 */
function checkPositions(): void {
  // Check BTC position
  const btcPos = state.positions.btc;
  if (btcPos && state.markets.btc) {
    const { shouldExit, reason } = shouldExitPosition(btcPos, state.markets.btc);
    if (shouldExit && reason) {
      exitPosition(btcPos, reason);
    }
  }

  // Check ETH position
  const ethPos = state.positions.eth;
  if (ethPos && state.markets.eth) {
    const { shouldExit, reason } = shouldExitPosition(ethPos, state.markets.eth);
    if (shouldExit && reason) {
      exitPosition(ethPos, reason);
    }
  }
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
  return timeLeft < 30000;
}

async function refreshMarket(token: 'btc' | 'eth'): Promise<boolean> {
  const sdk = state.sdk;
  if (!sdk) return false;

  const oldMarket = state.markets[token];
  if (!oldMarket) return false;

  console.log(`🔄 Refreshing ${token.toUpperCase()} market...`);

  const newMarket = await discoverMarket(token);
  if (!newMarket) {
    console.log(`⚠️  No new ${token.toUpperCase()} market found`);
    return false;
  }

  if (newMarket.endTime <= oldMarket.endTime) {
    return false;
  }

  const tokenKey = token as 'btc' | 'eth';

  // Clean up old subscription
  const oldSubscription = state.subscriptions[tokenKey];
  if (oldSubscription?.subscription) {
    oldSubscription.subscription.unsubscribe();
    state.subscriptions[tokenKey] = null;
  }

  // Update state with new market
  state.markets[tokenKey] = newMarket;
  state.updateCounts[tokenKey] = 0;

  // Re-subscribe
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
  updateSignalBox(token === 'BTC' ? btcSignalBox : ethSignalBox, newMarket, token);
  updateOrderBook(token === 'BTC' ? btcOrderBookBox : ethOrderBookBox, newMarket, token);
  updateStatusBar();
  scheduleRender();

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

  if (count === 1 && bids.length > 0) {
    console.log(`✓ ${market.token}: Connected`);
  }

  // Check for entry signal (only if no position exists)
  if (!state.positions[tokenKey]) {
    const entrySignal = shouldEnterPosition(market);
    if (entrySignal) {
      enterPosition(market, entrySignal);
    }
  }

  // Update UI
  updateSignalBox(market.token === 'BTC' ? btcSignalBox : ethSignalBox, market, market.token);
  updateOrderBook(market.token === 'BTC' ? btcOrderBookBox : ethOrderBookBox, market, market.token);
  updateStatusBar();
  scheduleRender();
}

// ===== Main =====
async function main(): Promise<void> {
  updateHeader();
  updatePnlBox();
  screen.render();

  // Cleanup handler
  const cleanup = () => {
    if (state.timers.refreshCheck) {
      clearInterval(state.timers.refreshCheck);
      state.timers.refreshCheck = null;
    }
    if (state.timers.uiUpdate) {
      clearInterval(state.timers.uiUpdate);
      state.timers.uiUpdate = null;
    }
    if (state.timers.positionCheck) {
      clearInterval(state.timers.positionCheck);
      state.timers.positionCheck = null;
    }
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }

    state.subscriptions.btc?.subscription.unsubscribe();
    state.subscriptions.eth?.subscription.unsubscribe();
    state.sdk?.realtime.disconnect();
  };

  screen.key(['q', 'C-c'], () => {
    cleanup();
    process.exit(0);
  });

  const sdk = new PolymarketSDK();
  state.sdk = sdk;

  // Only initialize trading service if NOT in dry run mode
  if (!DRY_RUN) {
    console.log('⚠️  LIVE TRADING MODE ENABLED');
    console.log('   This requires:');
    console.log('   - Valid Polymarket wallet with USDC deposited');
    console.log('   - Private key that matches your Polymarket account');
    console.log('   - No Cloudflare block on your IP');
    console.log('');

    try {
      await sdk.initialize();
      console.log('✓ Trading initialized successfully');
      console.log('⚠️  REAL MONEY AT RISK!');
    } catch (error) {
      console.error('✗ Failed to initialize trading:', error);
      if (error instanceof Error && error.message.includes('Could not create api key')) {
        console.error('');
        console.error('   This usually means:');
        console.error('   1. Your private key is not linked to a Polymarket account');
        console.error('   2. Your IP is being blocked by Cloudflare');
        console.error('   3. Polymarket API is temporarily unavailable');
        console.error('');
        console.error('   Solution: Use DRY_RUN=true for testing, or');
        console.error('           use a wallet with active Polymarket account');
      }
      console.error('   Falling back to DRY_RUN mode');
      process.env.DRY_RUN = 'true';
    }
  } else {
    console.log('✓ DRY-RUN mode - No real trades will be executed');
    console.log('  (Set DRY_RUN=false in .env for live trading)');
  }

  // Discover markets
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
  updatePositionBox(btcPositionBox, null, 'BTC');
  updatePositionBox(ethPositionBox, null, 'ETH');
  updateStatusBar();
  screen.render();

  // Connect to WebSocket
  sdk.realtime.connect();

  sdk.realtime.on('connected', () => {
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

  // Check for market refresh every 5 seconds
  state.timers.refreshCheck = setInterval(async () => {
    if (needsRefresh(state.markets.btc)) {
      await refreshMarket('btc');
    }
    if (needsRefresh(state.markets.eth)) {
      await refreshMarket('eth');
    }
  }, 5000);

  // Check positions every 2 seconds (for exit conditions)
  state.timers.positionCheck = setInterval(() => {
    checkPositions();
  }, 2000);

  // Update UI every second
  state.timers.uiUpdate = setInterval(() => {
    if (state.markets.btc) {
      updateSignalBox(btcSignalBox, state.markets.btc, 'BTC');
      updateOrderBook(btcOrderBookBox, state.markets.btc, 'BTC');
    }
    if (state.markets.eth) {
      updateSignalBox(ethSignalBox, state.markets.eth, 'ETH');
      updateOrderBook(ethOrderBookBox, state.markets.eth, 'ETH');
    }
    if (state.positions.btc) {
      updatePositionBox(btcPositionBox, state.positions.btc, 'BTC');
    }
    if (state.positions.eth) {
      updatePositionBox(ethPositionBox, state.positions.eth, 'ETH');
    }
    updatePnlBox();
    updateStatusBar();
    scheduleRender();
  }, 1000);

  screen.render();
}

main().catch(console.error);
