/**
 * SmartMoneyService
 *
 * Smart Money tracking and Copy Trading functionality.
 *
 * ============================================================================
 * 设计决策 (Design Decisions)
 * ============================================================================
 *
 * ## 1. 信号监控方式 (Signal Detection)
 *
 * 我们选择 **Activity WebSocket** 作为监控方式，原因：
 *
 * | 方案 | 延迟 | 是否包含钱包地址 | 适用性 |
 * |------|------|-----------------|--------|
 * | Activity WebSocket | < 100ms | ✅ trader.address | 最快，推荐 |
 * | Data API 轮询 | 2-5s | ✅ maker address | 备用方案 |
 * | Subgraph 轮询 | 5-15s | ✅ maker/taker | 数据完整但慢 |
 *
 * Activity WebSocket 经过实测验证 (2025-12-28)：
 * - 延迟 < 100ms
 * - 交易数据结构: { trader: { name, address }, ... }
 * - 支持按 eventSlug/marketSlug 过滤
 *
 * ## 2. 跟单方式分类 (Copy Trading Modes)
 *
 * | 方式 | 描述 | 延迟敏感度 | 实现方法 |
 * |------|------|-----------|---------|
 * | 跟成交 | 目标成交后立即跟单 | 高 | subscribeSmartMoneyTrades + Market Order |
 * | 跟持仓 | 定期同步目标持仓 | 低 | syncPositions + Limit Order |
 * | 跟信号 | 分析交易模式后跟单 | 中 | analyzeSignals + Limit/Market Order |
 *
 * ## 3. 下单方式选择 (Order Type Selection)
 *
 * | 下单方式 | 使用场景 | 特点 |
 * |----------|---------|------|
 * | FOK (Fill or Kill) | 跟成交 - 小额 | 全部成交或取消，确定性最高 |
 * | FAK (Fill and Kill) | 跟成交 - 大额 | 部分成交也接受，成交率高 |
 * | GTC (Good Till Cancel) | 跟持仓/跟信号 | 挂单等待，可获得更好价格 |
 * | GTD (Good Till Date) | 短期信号 | 限时挂单，避免长期暴露 |
 *
 * **推荐配置：**
 * - 跟成交场景：使用 createMarketOrder (FOK/FAK)，maxSlippage: 3%
 * - 跟持仓/信号：使用 createLimitOrder (GTC)，无滑点但可能不成交
 *
 * ## 4. 输入参数设计
 *
 * subscribeSmartMoneyTrades 的输入：
 * - walletAddresses: string[] - 要跟踪的钱包地址列表
 * - filter: { marketSlug?, minSize? } - 可选过滤条件
 *
 * 监控流程：
 * 1. 使用 subscribeAllActivity() 监听全局交易活动 (最快方式)
 * 2. 客户端过滤出目标钱包的交易 (通过 trader.address 匹配)
 * 3. 触发回调，由调用者决定是否跟单
 *
 * ## 5. 重要限制 (实测验证 2025-12-28)
 *
 * ⚠️ **Activity WebSocket 不会广播用户自己的交易！**
 *
 * | 验证方式 | 能看到自己的交易? |
 * |---------|------------------|
 * | Activity WebSocket | ❌ 不能 |
 * | getTrades() API | ✅ 能 |
 * | clob_user topic | ✅ 能 (需认证) |
 *
 * 如需验证自己的跟单是否成功，请使用 TradingService.getTrades()
 *
 * ============================================================================
 */

import type { WalletService, SellActivityResult } from './wallet-service.js';
import type { RealtimeServiceV2, ActivityTrade } from './realtime-service-v2.js';
import type { TradingService, OrderResult } from './trading-service.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Smart Money wallet information
 */
export interface SmartMoneyWallet {
  /** Wallet address */
  address: string;
  /** Display name (if available) */
  name?: string;
  /** Total PnL in USDC */
  pnl: number;
  /** Win rate (0-1) */
  winRate: number;
  /** Number of positions */
  positionCount: number;
  /** Volume traded in USDC */
  volume: number;
  /** Smart Money score (higher = better) */
  score: number;
  /** Ranking position */
  rank?: number;
}

/**
 * Smart Money trade (enriched from Activity WebSocket)
 */
export interface SmartMoneyTrade {
  /** Trader address */
  traderAddress: string;
  /** Trader name (if available) */
  traderName?: string;
  /** Market condition ID */
  conditionId?: string;
  /** Market slug */
  marketSlug?: string;
  /** Trade side */
  side: 'BUY' | 'SELL';
  /** Trade size in shares */
  size: number;
  /** Trade price */
  price: number;
  /** Token ID */
  tokenId?: string;
  /** Outcome (YES/NO) */
  outcome?: string;
  /** Transaction hash */
  txHash?: string;
  /** Timestamp */
  timestamp: number;
  /** Is this a Smart Money trader */
  isSmartMoney: boolean;
  /** Smart Money wallet info (if available) */
  smartMoneyInfo?: SmartMoneyWallet;
}

/**
 * Position snapshot for a trader
 */
export interface PositionSnapshot {
  /** Trader address */
  traderAddress: string;
  /** Positions */
  positions: TraderPosition[];
  /** Snapshot timestamp */
  timestamp: number;
}

export interface TraderPosition {
  /** Market condition ID */
  conditionId: string;
  /** Market question */
  question?: string;
  /** Token ID */
  tokenId: string;
  /** Outcome (YES/NO) */
  outcome: string;
  /** Size in shares */
  size: number;
  /** Average entry price */
  avgPrice: number;
  /** Current price */
  currentPrice?: number;
  /** Unrealized PnL */
  unrealizedPnl?: number;
}

/**
 * Trading signal derived from Smart Money activity
 */
export interface TradingSignal {
  /** Signal type */
  type: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
  /** Confidence score (0-1) */
  confidence: number;
  /** Market condition ID */
  conditionId?: string;
  /** Market slug */
  marketSlug?: string;
  /** Suggested side */
  side: 'BUY' | 'SELL';
  /** Suggested outcome */
  outcome: 'YES' | 'NO';
  /** Suggested price (optional) */
  suggestedPrice?: number;
  /** Suggested size (optional) */
  suggestedSize?: number;
  /** Reasons for the signal */
  reasons: string[];
  /** Trades that contributed to this signal */
  contributingTrades: SmartMoneyTrade[];
  /** Timestamp */
  timestamp: number;
}

/**
 * Copy trade options
 *
 * 下单方式选择指南：
 * - 跟成交场景 (需要快速执行)：
 *   - executionMode: 'market'
 *   - marketOrderType: 'FOK' (小额) 或 'FAK' (大额)
 *   - maxSlippage: 0.03 (3%)
 *
 * - 跟持仓/跟信号场景 (可以等待更好价格)：
 *   - executionMode: 'limit'
 *   - limitOrderType: 'GTC' 或 'GTD'
 */
export interface CopyTradeOptions {
  /** Scale factor for size (0.1 = 10% of original size) */
  sizeScale?: number;
  /** Maximum size in USDC */
  maxSize?: number;
  /** Maximum slippage tolerance for market orders (e.g., 0.03 = 3%) */
  maxSlippage?: number;
  /** Delay before executing (ms) */
  delay?: number;

  /**
   * Execution mode:
   * - 'market': Use Market Order (FOK/FAK) - 跟成交场景，快速执行
   * - 'limit': Use Limit Order (GTC/GTD) - 跟持仓/信号场景，等待成交
   */
  executionMode?: 'market' | 'limit';

  /**
   * Market order type (only used when executionMode = 'market'):
   * - 'FOK': Fill or Kill - 全部成交或取消，适合小额跟单
   * - 'FAK': Fill and Kill - 部分成交也可以，适合大额跟单
   */
  marketOrderType?: 'FOK' | 'FAK';

  /**
   * Limit order type (only used when executionMode = 'limit'):
   * - 'GTC': Good Till Cancel - 挂单直到成交或取消
   * - 'GTD': Good Till Date - 限时挂单
   */
  limitOrderType?: 'GTC' | 'GTD';
}

/**
 * Smart Money service configuration
 */
export interface SmartMoneyServiceConfig {
  /** Minimum PnL to be considered Smart Money (default: $1000) */
  minPnl?: number;
  /** Minimum win rate to be considered Smart Money (default: 0.55) */
  minWinRate?: number;
  /** Minimum positions to be considered Smart Money (default: 10) */
  minPositions?: number;
  /** Minimum trade size to consider (default: $10) */
  minTradeSize?: number;
  /** Cache TTL for Smart Money list (default: 300000 = 5 min) */
  cacheTtl?: number;
}

// ============================================================================
// SmartMoneyService
// ============================================================================

export class SmartMoneyService {
  private walletService: WalletService;
  private realtimeService: RealtimeServiceV2;
  private tradingService: TradingService;
  private config: Required<SmartMoneyServiceConfig>;

  // Smart Money cache
  private smartMoneyCache: Map<string, SmartMoneyWallet> = new Map();
  private smartMoneySet: Set<string> = new Set();
  private cacheTimestamp: number = 0;

  // Active subscriptions
  private activeSubscription: { unsubscribe: () => void } | null = null;
  private tradeHandlers: Set<(trade: SmartMoneyTrade) => void> = new Set();

  constructor(
    walletService: WalletService,
    realtimeService: RealtimeServiceV2,
    tradingService: TradingService,
    config: SmartMoneyServiceConfig = {}
  ) {
    this.walletService = walletService;
    this.realtimeService = realtimeService;
    this.tradingService = tradingService;

    this.config = {
      minPnl: config.minPnl ?? 1000,
      minWinRate: config.minWinRate ?? 0.55,
      minPositions: config.minPositions ?? 10,
      minTradeSize: config.minTradeSize ?? 10,
      cacheTtl: config.cacheTtl ?? 300000, // 5 minutes
    };
  }

  // ============================================================================
  // Smart Money Detection
  // ============================================================================

  /**
   * Get list of Smart Money wallets
   * Uses leaderboard data from WalletService
   */
  async getSmartMoneyList(limit: number = 100): Promise<SmartMoneyWallet[]> {
    // Check cache
    if (this.isCacheValid()) {
      return Array.from(this.smartMoneyCache.values());
    }

    // Fetch leaderboard (returns LeaderboardPage with entries array)
    const leaderboardPage = await this.walletService.getLeaderboard(0, limit);
    const entries = leaderboardPage.entries;

    // Filter and transform to SmartMoneyWallet
    const smartMoneyList: SmartMoneyWallet[] = [];

    for (let i = 0; i < entries.length; i++) {
      const trader = entries[i];

      // Apply filters based on available data
      // Note: LeaderboardEntry has pnl, volume, positions, but no winRate
      if (trader.pnl < this.config.minPnl) continue;
      const positions = trader.positions ?? 0;
      if (positions < this.config.minPositions) continue;

      // Estimate win rate from PnL (positive PnL suggests good win rate)
      const estimatedWinRate = trader.pnl > 0 ? 0.6 : 0.4;
      if (estimatedWinRate < this.config.minWinRate) continue;

      const wallet: SmartMoneyWallet = {
        address: trader.address.toLowerCase(),
        name: trader.userName,
        pnl: trader.pnl,
        winRate: estimatedWinRate,
        positionCount: positions,
        volume: trader.volume,
        score: this.calculateSmartMoneyScoreFromEntry(trader),
        rank: trader.rank ?? i + 1,
      };

      smartMoneyList.push(wallet);
      this.smartMoneyCache.set(wallet.address, wallet);
      this.smartMoneySet.add(wallet.address);
    }

    this.cacheTimestamp = Date.now();
    return smartMoneyList;
  }

  /**
   * Check if an address is Smart Money
   */
  async isSmartMoney(address: string): Promise<boolean> {
    const normalizedAddress = address.toLowerCase();

    // Check cache first
    if (this.isCacheValid()) {
      return this.smartMoneySet.has(normalizedAddress);
    }

    // Refresh cache if stale
    await this.getSmartMoneyList();
    return this.smartMoneySet.has(normalizedAddress);
  }

  /**
   * Get Smart Money info for an address
   */
  async getSmartMoneyInfo(address: string): Promise<SmartMoneyWallet | null> {
    const normalizedAddress = address.toLowerCase();

    // Check cache first
    if (this.isCacheValid() && this.smartMoneyCache.has(normalizedAddress)) {
      return this.smartMoneyCache.get(normalizedAddress)!;
    }

    // Refresh cache if stale
    await this.getSmartMoneyList();
    return this.smartMoneyCache.get(normalizedAddress) || null;
  }

  // ============================================================================
  // Copy Trading - 跟成交
  // ============================================================================

  /**
   * Subscribe to Smart Money trades
   * Real-time monitoring of trades from Smart Money wallets
   *
   * @returns Subscription object with id and unsubscribe method
   */
  subscribeSmartMoneyTrades(
    onTrade: (trade: SmartMoneyTrade) => void,
    options: {
      /** Only emit trades from specific addresses */
      filterAddresses?: string[];
      /** Only emit trades above this size */
      minSize?: number;
      /** Only emit trades from Smart Money wallets (default: false) */
      smartMoneyOnly?: boolean;
    } = {}
  ): { id: string; unsubscribe: () => void } {
    // Add handler to set
    this.tradeHandlers.add(onTrade);

    // Ensure we have Smart Money cache
    this.getSmartMoneyList().catch(() => {
      // Ignore errors, will work with empty cache
    });

    // Start activity subscription if not already started
    if (!this.activeSubscription) {
      this.activeSubscription = this.realtimeService.subscribeAllActivity({
        onTrade: (activityTrade: ActivityTrade) => {
          this.handleActivityTrade(activityTrade, options);
        },
        onError: (error) => {
          console.error('[SmartMoneyService] Activity subscription error:', error);
        },
      });
    }

    // Return subscription object
    return {
      id: `smart_money_${Date.now()}`,
      unsubscribe: () => {
        this.tradeHandlers.delete(onTrade);

        // If no more handlers, unsubscribe from activity
        if (this.tradeHandlers.size === 0 && this.activeSubscription) {
          this.activeSubscription.unsubscribe();
          this.activeSubscription = null;
        }
      },
    };
  }

  /**
   * Handle incoming activity trade
   */
  private async handleActivityTrade(
    trade: ActivityTrade,
    options: { filterAddresses?: string[]; minSize?: number; smartMoneyOnly?: boolean }
  ): Promise<void> {
    // 使用 trader.address - 实测验证 (2025-12-28) 正确的字段
    const rawAddress = trade.trader?.address;
    if (!rawAddress) return;

    const traderAddress = rawAddress.toLowerCase();

    // Apply address filter (if specified)
    if (options.filterAddresses && options.filterAddresses.length > 0) {
      const normalizedFilter = options.filterAddresses.map(a => a.toLowerCase());
      if (!normalizedFilter.includes(traderAddress)) return;
    }

    // Apply size filter
    if (options.minSize && trade.size < options.minSize) return;

    // Check if Smart Money (optional enrichment)
    const isSmartMoney = this.smartMoneySet.has(traderAddress);
    const smartMoneyInfo = this.smartMoneyCache.get(traderAddress);

    // Only filter by Smart Money if explicitly requested
    if (options.smartMoneyOnly && !isSmartMoney) return;

    // Create enriched trade
    const smartMoneyTrade: SmartMoneyTrade = {
      traderAddress,
      traderName: trade.trader?.name,
      conditionId: trade.conditionId,
      marketSlug: trade.marketSlug,
      side: trade.side,
      size: trade.size,
      price: trade.price,
      tokenId: trade.asset, // ActivityTrade uses 'asset' instead of 'tokenId'
      outcome: trade.outcome,
      txHash: trade.transactionHash, // ActivityTrade uses 'transactionHash'
      timestamp: trade.timestamp,
      isSmartMoney,
      smartMoneyInfo,
    };

    // Emit to all handlers
    for (const handler of this.tradeHandlers) {
      try {
        handler(smartMoneyTrade);
      } catch (error) {
        console.error('[SmartMoneyService] Handler error:', error);
      }
    }
  }

  // ============================================================================
  // Copy Trading - 跟持仓
  // ============================================================================

  /**
   * Sync positions from multiple traders
   */
  async syncPositions(addresses: string[]): Promise<PositionSnapshot[]> {
    const snapshots: PositionSnapshot[] = [];

    for (const address of addresses) {
      try {
        // Use getWalletPositions from WalletService (returns Position[] from Data API)
        const positions = await this.walletService.getWalletPositions(address);

        const traderPositions: TraderPosition[] = positions.map(p => ({
          conditionId: p.conditionId,
          question: p.title, // Position uses 'title' for market question
          tokenId: p.asset, // Position uses 'asset' for token ID
          outcome: p.outcome,
          size: p.size,
          avgPrice: p.avgPrice ?? 0,
          currentPrice: p.curPrice ?? 0, // Position uses 'curPrice'
          unrealizedPnl: p.cashPnl ?? 0, // Position uses 'cashPnl' for PnL
        }));

        snapshots.push({
          traderAddress: address.toLowerCase(),
          positions: traderPositions,
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error(`[SmartMoneyService] Failed to sync positions for ${address}:`, error);
      }
    }

    return snapshots;
  }

  // ============================================================================
  // Signal Analysis - 跟信号
  // ============================================================================

  /**
   * Analyze trades to generate trading signals
   */
  analyzeSignals(
    trades: SmartMoneyTrade[],
    options: {
      /** Time window for aggregation (ms) */
      timeWindow?: number;
      /** Minimum trades to generate signal */
      minTrades?: number;
    } = {}
  ): TradingSignal[] {
    const timeWindow = options.timeWindow ?? 300000; // 5 minutes
    const minTrades = options.minTrades ?? 2;

    const now = Date.now();
    const recentTrades = trades.filter(t => now - t.timestamp < timeWindow);

    // Group by market
    const marketGroups = new Map<string, SmartMoneyTrade[]>();
    for (const trade of recentTrades) {
      const key = trade.marketSlug || trade.conditionId || 'unknown';
      if (!marketGroups.has(key)) {
        marketGroups.set(key, []);
      }
      marketGroups.get(key)!.push(trade);
    }

    // Generate signals for each market
    const signals: TradingSignal[] = [];

    for (const [marketKey, marketTrades] of marketGroups) {
      if (marketTrades.length < minTrades) continue;

      const signal = this.generateSignalFromTrades(marketTrades);
      if (signal) {
        signals.push(signal);
      }
    }

    return signals;
  }

  private generateSignalFromTrades(trades: SmartMoneyTrade[]): TradingSignal | null {
    if (trades.length === 0) return null;

    // Count buys vs sells
    let buyVolume = 0;
    let sellVolume = 0;
    let smartMoneyBuyVolume = 0;
    let smartMoneySellVolume = 0;

    for (const trade of trades) {
      const volume = trade.size * trade.price;
      if (trade.side === 'BUY') {
        buyVolume += volume;
        if (trade.isSmartMoney) smartMoneyBuyVolume += volume;
      } else {
        sellVolume += volume;
        if (trade.isSmartMoney) smartMoneySellVolume += volume;
      }
    }

    const totalVolume = buyVolume + sellVolume;
    if (totalVolume === 0) return null;

    const buyRatio = buyVolume / totalVolume;
    const smartMoneyRatio = (smartMoneyBuyVolume + smartMoneySellVolume) / totalVolume;

    // Determine signal type
    let type: TradingSignal['type'];
    let side: 'BUY' | 'SELL';
    const reasons: string[] = [];

    if (buyRatio > 0.8) {
      type = smartMoneyRatio > 0.5 ? 'strong_buy' : 'buy';
      side = 'BUY';
      reasons.push(`${(buyRatio * 100).toFixed(0)}% of volume is buying`);
    } else if (buyRatio < 0.2) {
      type = smartMoneyRatio > 0.5 ? 'strong_sell' : 'sell';
      side = 'SELL';
      reasons.push(`${((1 - buyRatio) * 100).toFixed(0)}% of volume is selling`);
    } else {
      type = 'neutral';
      side = buyRatio > 0.5 ? 'BUY' : 'SELL';
      reasons.push('Mixed trading activity');
    }

    if (smartMoneyRatio > 0.3) {
      reasons.push(`${(smartMoneyRatio * 100).toFixed(0)}% Smart Money participation`);
    }

    // Calculate confidence
    const confidence = Math.min(1, (trades.length / 10) * 0.5 + smartMoneyRatio * 0.5);

    // Get average price
    const avgPrice = trades.reduce((sum, t) => sum + t.price, 0) / trades.length;

    const sample = trades[0];
    return {
      type,
      confidence,
      conditionId: sample.conditionId,
      marketSlug: sample.marketSlug,
      side,
      outcome: sample.outcome === 'NO' ? 'NO' : 'YES',
      suggestedPrice: avgPrice,
      reasons,
      contributingTrades: trades,
      timestamp: Date.now(),
    };
  }

  // ============================================================================
  // Trade Execution
  // ============================================================================

  /**
   * Execute a copy trade based on a signal
   *
   * 下单方式选择：
   * - executionMode: 'market' (默认) → 使用 Market Order，快速执行
   *   - 适用于"跟成交"场景，需要尽快跟上目标交易
   *   - FOK: 全部成交或取消 (小额推荐)
   *   - FAK: 部分成交也接受 (大额推荐)
   *
   * - executionMode: 'limit' → 使用 Limit Order，等待成交
   *   - 适用于"跟持仓/跟信号"场景，可以等待更好价格
   *   - GTC: 挂单直到成交
   *   - GTD: 限时挂单
   */
  async executeCopyTrade(
    signal: TradingSignal,
    options: CopyTradeOptions = {}
  ): Promise<OrderResult> {
    const sizeScale = options.sizeScale ?? 0.1;
    const maxSize = options.maxSize ?? 100;
    const maxSlippage = options.maxSlippage ?? 0.03; // 默认 3% 滑点
    const delay = options.delay ?? 0;
    const executionMode = options.executionMode ?? 'market'; // 默认使用 Market Order

    // Wait if delay specified
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    // Calculate size
    const originalSize = signal.contributingTrades.reduce((sum, t) => sum + t.size, 0) / signal.contributingTrades.length;
    let size = originalSize * sizeScale;

    // Get suggested price
    const price = signal.suggestedPrice ?? 0.5;

    // Apply max size limit (in USDC)
    const usdcValue = size * price;
    if (usdcValue > maxSize) {
      size = maxSize / price;
    }

    // Find token ID
    const tokenId = signal.contributingTrades[0]?.tokenId;
    if (!tokenId) {
      return {
        success: false,
        errorMsg: 'No token ID found in signal',
      };
    }

    // Execute order based on execution mode
    if (executionMode === 'market') {
      // Market Order: 快速执行，适合"跟成交"场景
      // - FOK: 全部成交或取消 (确定性高，适合小额)
      // - FAK: 部分成交也接受 (成交率高，适合大额)
      const marketOrderType = options.marketOrderType ?? (usdcValue > 50 ? 'FAK' : 'FOK');

      // Calculate limit price with slippage for market order
      const slippagePrice = signal.side === 'BUY'
        ? price * (1 + maxSlippage)  // 买入时接受更高价格
        : price * (1 - maxSlippage); // 卖出时接受更低价格

      return this.tradingService.createMarketOrder({
        tokenId,
        side: signal.side,
        amount: usdcValue, // Market order 使用 USDC 金额
        price: slippagePrice,
        orderType: marketOrderType,
      });
    } else {
      // Limit Order: 挂单等待，适合"跟持仓/跟信号"场景
      // - GTC: 挂单直到成交或取消
      // - GTD: 限时挂单
      const limitOrderType = options.limitOrderType ?? 'GTC';

      return this.tradingService.createLimitOrder({
        tokenId,
        side: signal.side,
        price,
        size,
        orderType: limitOrderType,
      });
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private isCacheValid(): boolean {
    return Date.now() - this.cacheTimestamp < this.config.cacheTtl && this.smartMoneyCache.size > 0;
  }

  /**
   * Calculate Smart Money score from LeaderboardEntry
   * Uses available fields: pnl, volume, positions, rank
   */
  private calculateSmartMoneyScoreFromEntry(entry: {
    pnl: number;
    volume: number;
    positions?: number;
    rank?: number;
  }): number {
    // Weighted score based on:
    // - PnL (50%) - primary indicator
    // - Volume (30%) - trading activity
    // - Positions (20%) - diversification

    const pnlScore = Math.min(50, Math.max(0, (entry.pnl / 10000) * 50));
    const volumeScore = Math.min(30, (entry.volume / 100000) * 30);
    const positionsScore = Math.min(20, ((entry.positions ?? 0) / 50) * 20);

    return Math.round(pnlScore + volumeScore + positionsScore);
  }

  // ============================================================================
  // Sell Detection (Follow Wallet Exit Strategy)
  // ============================================================================

  /**
   * Detect sell activity for a wallet in a specific market
   *
   * Use this to detect when a followed wallet is exiting a position.
   * This is useful for "follow the exit" strategies.
   *
   * @param address - Wallet address to check
   * @param conditionId - Market condition ID
   * @param sinceTimestamp - Only consider sells after this timestamp
   * @param peakValue - Optional peak position value to calculate sell ratio
   * @returns Sell activity result with total sell amount, transactions, and exit signal
   */
  async detectSellActivity(
    address: string,
    conditionId: string,
    sinceTimestamp: number,
    peakValue?: number
  ): Promise<SellActivityResult> {
    return this.walletService.detectSellActivity(address, conditionId, sinceTimestamp, peakValue);
  }

  /**
   * Track sell ratio for multiple Smart Money wallets (aggregated)
   *
   * Use this to detect when multiple followed wallets are exiting a position.
   * When sell ratio exceeds 30%, consider it an exit signal.
   *
   * @param addresses - List of wallet addresses to track
   * @param conditionId - Market condition ID
   * @param peakTotalValue - Peak total position value across all wallets
   * @param sinceTimestamp - Only consider sells after this timestamp
   * @returns Aggregated sell data with cumulative sell amount, ratio, and exit signal
   */
  async trackGroupSellRatio(
    addresses: string[],
    conditionId: string,
    peakTotalValue: number,
    sinceTimestamp: number
  ): Promise<{
    cumulativeSellAmount: number;
    sellRatio: number;
    shouldExit: boolean;
    walletSells: Array<{ address: string; sellAmount: number }>;
  }> {
    return this.walletService.trackGroupSellRatio(addresses, conditionId, peakTotalValue, sinceTimestamp);
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Disconnect and cleanup
   */
  disconnect(): void {
    if (this.activeSubscription) {
      this.activeSubscription.unsubscribe();
      this.activeSubscription = null;
    }
    this.tradeHandlers.clear();
    this.smartMoneyCache.clear();
    this.smartMoneySet.clear();
  }
}
