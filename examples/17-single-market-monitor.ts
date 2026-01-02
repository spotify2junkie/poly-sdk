#!/usr/bin/env tsx
/**
 * Single Market Monitor - Auto-discovers latest 15m BTC market
 *
 * Usage:
 *   pnpm example:single-monitor          # Auto-discover latest BTC 15m
 *   pnpm example:single-monitor --market-id=0x...  # Specific market
 */

import 'dotenv/config';
import { PolymarketSDK } from '../src/index.js';
import type { OrderbookSnapshot, MarketEvent } from '../src/services/realtime-service-v2.js';
import chalk from 'chalk';

const CONFIG = {
  // Single market ID (optional - will auto-discover if not provided)
  marketId: process.argv.find(a => a.startsWith('--market-id='))?.split('=')[1] ||
            process.env.MARKET_ID ||
            '',
};

interface MarketState {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  orderbook?: OrderbookSnapshot;
}

const state = {
  sdk: null as PolymarketSDK | null,
  market: null as MarketState | null,
  lastUpdateTime: 0,
  isShuttingDown: false,
  subscriptions: [] as any[],
  marketEventSubscription: null as any,
};

const isTTY = process.stdout.isTTY;

// ===== Auto-Discovery =====
async function findLatestBTC15mMarket(sdk: PolymarketSDK): Promise<string | null> {
  try {
    // Search for latest BTC 15-minute markets
    const response = await fetch('https://gamma-api.polymarket.com/markets?search=btc%20up%20down%2015m&limit=10&ordering=-createdAt');
    const markets = await response.json();

    // Find active 15m market
    const market = markets.find((m: any) =>
      m.active &&
      m.slug.includes('btc-updown-15m') &&
      m.question?.includes('Up or Down')
    );

    if (market) {
      console.log(chalk.green(`✓ Found market: ${market.question}`));
      return market.conditionId;
    }

    return null;
  } catch (error) {
    console.error(chalk.red('Failed to discover market'), (error as Error).message);
    return null;
  }
}

async function loadMarket(sdk: PolymarketSDK, marketId: string): Promise<void> {
  try {
    // Use Gamma API directly (more reliable for token IDs)
    const response = await fetch(`https://gamma-api.polymarket.com/markets?condition_ids=${marketId}`);
    const data = await response.json();
    const gammaMarket = data[0];

    if (!gammaMarket) {
      throw new Error('Market not found');
    }

    const tokenIds = JSON.parse(gammaMarket.clobTokenIds || '[]');
    if (!tokenIds || tokenIds.length < 2) {
      throw new Error('Missing token IDs');
    }

    state.market = {
      conditionId: gammaMarket.conditionId,
      question: gammaMarket.question,
      yesTokenId: tokenIds[0], // First token is YES
      noTokenId: tokenIds[1],   // Second token is NO
    };

    console.log(chalk.green(`✓ Loaded: ${state.market.question}`));
  } catch (error) {
    console.error(chalk.red('✗ Failed to load market'), (error as Error).message);
    throw error;
  }
}

// ===== WebSocket =====
async function subscribeToMarket(sdk: PolymarketSDK): Promise<void> {
  if (!state.market) return;

  console.log(chalk.cyan('Subscribing to orderbook...'));

  const yesSub = sdk.realtime.subscribeMarket(
    state.market.yesTokenId,
    state.market.noTokenId,
    {
      onOrderbook: (book) => {
        if (book.assetId === state.market?.yesTokenId) {
          state.market!.orderbook = book;
          state.lastUpdateTime = Date.now();
          renderDashboard();
        }
      },
      onError: (error) => {
        console.error(chalk.red('Orderbook error:'), error.message);
      },
    }
  );

  state.subscriptions.push(yesSub);
}

// ===== Rendering =====
let lastRenderTime = 0;
const MIN_RENDER_INTERVAL_MS = 100;

function scheduleRender(): void {
  const now = Date.now();
  if (now - lastRenderTime < MIN_RENDER_INTERVAL_MS) return;
  lastRenderTime = now;
  renderDashboard();
}

function renderDashboard(): void {
  if (!isTTY) return renderPlain();

  process.stdout.write('\x1b[2J\x1b[H');

  const width = 79;
  console.log(chalk.cyan.bold('╔' + '═'.repeat(width - 2) + '╗'));

  const status = state.lastUpdateTime && (Date.now() - state.lastUpdateTime) < 30000
    ? chalk.green.bold('● Live')
    : chalk.yellow('● Connecting...');

  console.log(chalk.cyan('║') + ' ' +
    chalk.white.bold((state.market?.question || 'BTC 15m Monitor').substring(0, 60)) + ' ' +
    status + ' '.repeat(Math.max(0, width - 65 - (state.market?.question.length || 0))) +
    chalk.cyan('║'));

  console.log(chalk.cyan('╠' + '═'.repeat(width - 2) + '╣'));

  console.log(chalk.cyan('║  ') +
    chalk.bold('BIDS (BUY)'.padEnd(35)) +
    chalk.bold('ASKS (SELL)'.padEnd(35)) +
    chalk.cyan('║'));

  console.log(chalk.cyan('╠' + '═'.repeat(33) + '╦' + '═'.repeat(43) + '╣'));

  for (let i = 0; i < 5; i++) {
    const bid = state.market?.orderbook?.bids[i];
    const ask = state.market?.orderbook?.asks[i];

    const bidStr = bid
      ? chalk.green(`${(bid.price * 100).toFixed(1)}% @ ${formatSize(bid.size)}`)
      : chalk.dim('─'.repeat(20));

    const askStr = ask
      ? chalk.red(`${(ask.price * 100).toFixed(1)}% @ ${formatSize(ask.size)}`)
      : chalk.dim('─'.repeat(20));

    console.log(chalk.cyan('║  ') + bidStr.padEnd(33) + '║' + askStr.padEnd(43) + chalk.cyan('║'));
  }

  console.log(chalk.cyan('╚' + '═'.repeat(33) + '╩' + '═'.repeat(43) + '╝'));
}

function renderPlain(): void {
  const bid = state.market?.orderbook?.bids[0];
  const ask = state.market?.orderbook?.asks[0];
  console.log(`[${new Date().toISOString()}] Bid: ${bid ? (bid.price * 100).toFixed(1) + '%' : 'N/A'} | Ask: ${ask ? (ask.price * 100).toFixed(1) + '%' : 'N/A'}`);
}

function formatSize(size: number): string {
  if (size >= 1000000) return (size / 1000000).toFixed(1) + 'M';
  if (size >= 1000) return (size / 1000).toFixed(1) + 'K';
  return size.toFixed(0);
}

// ===== Shutdown =====
async function shutdown(signal: string): Promise<void> {
  if (state.isShuttingDown) return;
  state.isShuttingDown = true;

  for (const sub of state.subscriptions) {
    sub.unsubscribe?.();
  }
  state.marketEventSubscription?.unsubscribe();
  state.sdk?.realtime.disconnect();

  console.log(chalk.cyan(`\n👋 Shutting down (${signal})`));
  process.exit(0);
}

// ===== Main =====
async function main(): Promise<void> {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const sdk = new PolymarketSDK();
  state.sdk = sdk;

  console.log(chalk.cyan('Connecting to WebSocket...'));
  sdk.realtime.connect();

  sdk.realtime.on('connected', async () => {
    console.log(chalk.green('✓ WebSocket connected'));

    let marketId = CONFIG.marketId;

    // Auto-discover if no market ID provided
    if (!marketId) {
      console.log(chalk.cyan('🔍 Discovering latest BTC 15m market...'));
      marketId = await findLatestBTC15mMarket(sdk);
    }

    if (!marketId) {
      console.error(chalk.red('✗ No market found. Try again later.'));
      process.exit(1);
    }

    await loadMarket(sdk, marketId);
    await subscribeToMarket(sdk);
    console.log(chalk.cyan('Monitoring (Ctrl+C to stop)...'));
  });

  sdk.realtime.on('disconnected', () => {
    console.log(chalk.yellow('⚠ Disconnected. Reconnecting...'));
  });

  console.log(chalk.cyan('Waiting for connection...'));
}

main().catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});
