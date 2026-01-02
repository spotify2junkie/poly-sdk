#!/usr/bin/env tsx
/**
 * BTC/ETH 15-Minute Market Monitor
 *
 * Real-time orderbook monitoring for UP/DOWN prediction markets.
 * Phase 1: Read-only monitoring (no trading)
 * Phase 2: Trading execution (with PRIVATE_KEY)
 *
 * Usage:
 *   pnpm example:btc-eth-monitor
 *   pnpm example:btc-eth-monitor --up-market-id=0x123... --down-market-id=0x456...
 */

import 'dotenv/config';
import { PolymarketSDK } from '../src/index.js';
import type { OrderbookSnapshot } from '../src/services/realtime-service-v2.js';
import chalk from 'chalk';

// ===== Configuration =====
const CONFIG = {
  // Market IDs (from .env or CLI flags)
  upMarketId: process.env.UP_MARKET_ID,
  downMarketId: process.env.DOWN_MARKET_ID,

  // Render settings
  maxRenderHz: 10,  // Cap at 10 FPS
  minTerminalWidth: 80,
  minTerminalHeight: 20,

  // Reconnect settings
  reconnectIntervalMs: 3000,  // Try every 3 seconds
  maxReconnectAttempts: 10,   // Give up after 10 attempts
};

// ===== State =====
interface MarketState {
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  orderbook?: OrderbookSnapshot;
}

const state = {
  sdk: null as PolymarketSDK | null,
  upMarket: null as MarketState | null,
  downMarket: null as MarketState | null,
  lastUpdateTime: 0,
  reconnectAttempts: 0,
  isShuttingDown: false,
};

const isTTY = process.stdout.isTTY;

// ===== Market Loading =====
async function loadMarkets(sdk: PolymarketSDK): Promise<void> {
  // Get market IDs from CLI flags or .env
  const upMarketId = process.argv.find(a => a.startsWith('--up-market-id='))?.split('=')[1]
                  || process.env.UP_MARKET_ID;
  const downMarketId = process.argv.find(a => a.startsWith('--down-market-id='))?.split('=')[1]
                   || process.env.DOWN_MARKET_ID;

  if (!upMarketId || !downMarketId) {
    console.error(chalk.red('✗ Missing market IDs'));
    console.error(chalk.yellow('\nProvide market IDs via:'));
    console.error(chalk.dim('  CLI: --up-market-id=0x... --down-market-id=0x...'));
    console.error(chalk.dim('  .env: UP_MARKET_ID=0x...'));
    console.error(chalk.dim('\nTo find market IDs, visit: https://polymarket.com/crypto/15M'));
    console.error(chalk.dim('\nExample market URLs:'));
    console.error(chalk.dim('  - BTC: https://polymarket.com/event/btc-updown-15m-1767343500'));
    console.error(chalk.dim('  - ETH: https://polymarket.com/event/eth-updown-15m-1767343500'));
    console.error(chalk.dim('\nClick on a market, then use DevTools Network tab to find the conditionId'));
    console.error(chalk.dim('in API requests to https://gamma-api.polymarket.com/markets/'));
    process.exit(1);
  }

  // Load market data (get token IDs)
  try {
    const [upMarket, downMarket] = await Promise.all([
      sdk.markets.getClobMarket(upMarketId),
      sdk.markets.getClobMarket(downMarketId),
    ]);

    state.upMarket = {
      conditionId: upMarket.conditionId,
      yesTokenId: upMarket.tokens.find(t => t.outcome === 'Yes')?.tokenId || '',
      noTokenId: upMarket.tokens.find(t => t.outcome === 'No')?.tokenId || '',
    };

    state.downMarket = {
      conditionId: downMarket.conditionId,
      yesTokenId: downMarket.tokens.find(t => t.outcome === 'Yes')?.tokenId || '',
      noTokenId: downMarket.tokens.find(t => t.outcome === 'No')?.tokenId || '',
    };

    if (!state.upMarket.yesTokenId || !state.downMarket.yesTokenId) {
      throw new Error('Missing token IDs in market data');
    }
  } catch (error) {
    console.error(chalk.red('✗ Failed to load markets'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

// ===== WebSocket Subscriptions =====
async function subscribeToMarkets(sdk: PolymarketSDK): Promise<void> {
  if (!state.upMarket || !state.downMarket) return;

  const subscriptions: Array<ReturnType<typeof sdk.realtime.subscribeMarket>> = [];

  // Subscribe to UP market
  const upSub = sdk.realtime.subscribeMarket(
    state.upMarket.yesTokenId,
    state.upMarket.noTokenId,
    {
      onOrderbook: (book) => {
        if (book.assetId === state.upMarket?.yesTokenId) {
          state.upMarket!.orderbook = book;
          state.lastUpdateTime = Date.now();
          scheduleRender();
        }
      },
      onError: (error) => {
        logError('UP market error', error.message);
      },
    }
  );
  subscriptions.push(upSub);

  // Subscribe to DOWN market
  const downSub = sdk.realtime.subscribeMarket(
    state.downMarket.yesTokenId,
    state.downMarket.noTokenId,
    {
      onOrderbook: (book) => {
        if (book.assetId === state.downMarket?.yesTokenId) {
          state.downMarket!.orderbook = book;
          state.lastUpdateTime = Date.now();
          scheduleRender();
        }
      },
      onError: (error) => {
        logError('DOWN market error', error.message);
      },
    }
  );
  subscriptions.push(downSub);

  // Store for cleanup
  (state as any).subscriptions = subscriptions;
}

// ===== Rendering =====
let lastRenderTime = 0;
const MIN_RENDER_INTERVAL_MS = 100; // 10 Hz max

function scheduleRender(): void {
  const now = Date.now();
  if (now - lastRenderTime < MIN_RENDER_INTERVAL_MS) return;

  lastRenderTime = now;
  renderDashboard();
}

function renderDashboard(): void {
  if (!isTTY) {
    renderPlain();
    return;
  }

  clearScreen();
  renderHeader();
  renderOrderbookGrid();
}

function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[H');
}

function renderHeader(): void {
  const width = 79;
  console.log(chalk.cyan.bold('╔' + '═'.repeat(width - 2) + '╗'));

  // Title and status
  const status = isConnected()
    ? chalk.green.bold('● WS Live')
    : chalk.yellow('● Reconnecting...');
  const lastUpdate = state.lastUpdateTime
    ? chalk.dim(`Last update: ${new Date(state.lastUpdateTime).toLocaleTimeString()}`)
    : chalk.dim('Waiting for data...');

  console.log(chalk.cyan('║') +
    chalk.white.bold('  BTC/ETH 15m Monitor ') +
    status + ' ' + lastUpdate +
    ' '.repeat(Math.max(0, width - 50 - lastUpdate.length)) +
    chalk.cyan('║'));

  console.log(chalk.cyan('╠' + '═'.repeat(width - 2) + '╣'));
}

function renderOrderbookGrid(): void {
  const width = 79;

  // Header row
  console.log(chalk.cyan('║  ') +
    chalk.bold('UP MARKET'.padEnd(36)) +
    chalk.bold('DOWN MARKET'.padEnd(36)) +
    chalk.cyan('║'));

  console.log(chalk.cyan('║  ') +
    chalk.dim('BIDS'.padEnd(17)) +
    chalk.dim('ASKS'.padEnd(19)) +
    chalk.dim('BIDS'.padEnd(17)) +
    chalk.dim('ASKS'.padEnd(19)) +
    chalk.cyan('║'));

  console.log(chalk.cyan('╠' + '═'.repeat(35) + '╥' + '═'.repeat(41) + '╣'));

  // Data rows (top 5 levels)
  for (let i = 0; i < 5; i++) {
    const upBid = formatLevel(state.upMarket?.orderbook?.bids[i], 'green');
    const upAsk = formatLevel(state.upMarket?.orderbook?.asks[i], 'red');
    const downBid = formatLevel(state.downMarket?.orderbook?.bids[i], 'green');
    const downAsk = formatLevel(state.downMarket?.orderbook?.asks[i], 'red');

    console.log(chalk.cyan('║  ') +
      upBid.padEnd(17) + ' ' +
      upAsk.padEnd(19) + ' ' +
      downBid.padEnd(17) + ' ' +
      downAsk.padEnd(19) +
      chalk.cyan('║')
    );
  }

  console.log(chalk.cyan('╚' + '═'.repeat(35) + '╩' + '═'.repeat(41) + '╝'));
}

function formatLevel(level: { price: number; size: number } | undefined, color: 'green' | 'red'): string {
  if (!level) return chalk.dim('─'.repeat(15));

  const chalkColor = color === 'green' ? chalk.green : chalk.red;
  const price = (level.price * 100).toFixed(1) + '%';
  const size = formatSize(level.size);

  return chalkColor(`${price} @ ${size}`);
}

function formatSize(size: number): string {
  if (size >= 1000) return (size / 1000).toFixed(1) + 'K';
  if (size >= 1000000) return (size / 1000000).toFixed(1) + 'M';
  return size.toFixed(0);
}

function renderPlain(): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] UP Market:`);
  console.log(`  Bids: ${formatLevel(state.upMarket?.orderbook?.bids[0], 'green')}`);
  console.log(`  Asks: ${formatLevel(state.upMarket?.orderbook?.asks[0], 'red')}`);
  console.log(`DOWN Market:`);
  console.log(`  Bids: ${formatLevel(state.downMarket?.orderbook?.bids[0], 'green')}`);
  console.log(`  Asks: ${formatLevel(state.downMarket?.orderbook?.asks[0], 'red')}`);
}

// ===== Connection Management =====
function isConnected(): boolean {
  return state.lastUpdateTime > 0 && (Date.now() - state.lastUpdateTime) < 30000;
}

async function handleConnectionLost(): Promise<void> {
  if (state.reconnectAttempts >= CONFIG.maxReconnectAttempts) {
    logError('Connection failed', `Max reconnect attempts (${CONFIG.maxReconnectAttempts}) reached`);
    process.exit(1);
  }

  state.reconnectAttempts++;
  logError('Disconnected', `Reconnecting in ${CONFIG.reconnectIntervalMs/1000}s (attempt ${state.reconnectAttempts}/${CONFIG.maxReconnectAttempts})`);

  setTimeout(async () => {
    try {
      // Re-connect and re-subscribe
      state.sdk?.realtime.connect();
      // Wait for connection event (handled in main)
    } catch (error) {
      handleConnectionLost();
    }
  }, CONFIG.reconnectIntervalMs);
}

// ===== Logging =====
function logError(type: string, message: string): void {
  if (isTTY) {
    // In TTY mode, errors are shown in dashboard
  } else {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
    console.error(`[${timestamp}] ${chalk.red('[ERROR]')} ${type}: ${message}`);
  }
}

// ===== Shutdown =====
async function shutdown(signal: string): Promise<void> {
  if (state.isShuttingDown) return;
  state.isShuttingDown = true;

  // Unsubscribe
  const subscriptions = (state as any).subscriptions || [];
  for (const sub of subscriptions) {
    sub.unsubscribe?.();
  }

  // Disconnect
  state.sdk?.realtime.disconnect();

  // Final stats
  if (isTTY) {
    console.log(chalk.cyan('\n╔' + '═'.repeat(77) + '╗'));
    console.log(chalk.cyan('║') + chalk.yellow(`  Shutting down (${signal})`) + ' '.repeat(55) + chalk.cyan('║'));
    console.log(chalk.cyan('╚' + '═'.repeat(77) + '╝'));
  }

  process.exit(0);
}

// ===== Main =====
async function main(): Promise<void> {
  // Signal handlers
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Initialize SDK
  const sdk = new PolymarketSDK();
  state.sdk = sdk;

  // Load markets
  console.log(chalk.cyan('Loading markets...'));
  await loadMarkets(sdk);
  console.log(chalk.green('✓ Markets loaded'));
  console.log(chalk.dim(`  UP market: ${state.upMarket?.conditionId?.slice(0, 10)}...`));
  console.log(chalk.dim(`  DOWN market: ${state.downMarket?.conditionId?.slice(0, 10)}...`));

  // Connect WebSocket
  console.log(chalk.cyan('Connecting to WebSocket...'));
  sdk.realtime.connect();

  sdk.realtime.on('connected', () => {
    console.log(chalk.green('✓ WebSocket connected'));
    state.reconnectAttempts = 0;
    subscribeToMarkets(sdk);
  });

  sdk.realtime.on('disconnected', () => {
    handleConnectionLost();
  });

  // Keep alive
  console.log(chalk.cyan('Monitoring markets (Ctrl+C to stop)...'));
}

main().catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});
