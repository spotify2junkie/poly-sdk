/**
 * SmartMoneyService
 *
 * 聪明钱监控和自动跟单服务
 *
 * 核心功能：
 * 1. 监听指定地址的交易 - subscribeSmartMoneyTrades()
 * 2. 自动跟单 - startAutoCopyTrading()
 * 3. 聪明钱信息获取 - getSmartMoneyList(), getSmartMoneyInfo()
 *
 * ============================================================================
 * 设计决策
 * ============================================================================
 *
 * ## 监控方式
 * 使用 Activity WebSocket，延迟 < 100ms，实测验证有效。
 *
 * ## 下单方式
 * | 方式 | 使用场景 | 特点 |
 * |------|---------|------|
 * | FOK | 小额跟单 | 全部成交或取消 |
 * | FAK | 大额跟单 | 部分成交也接受 |
 *
 * ## 重要限制
 * ⚠️ Activity WebSocket 不会广播用户自己的交易！
 * 验证跟单结果请使用 TradingService.getTrades()
 */

import type { WalletService } from './wallet-service.js';
import type { RealtimeServiceV2, ActivityTrade } from './realtime-service-v2.js';
import type { TradingService, OrderResult } from './trading-service.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Smart Money wallet information
 */
export interface SmartMoneyWallet {
  address: string;
  name?: string;
  pnl: number;
  volume: number;
  score: number;
  rank?: number;
}

/**
 * Smart Money trade from Activity WebSocket
 */
export interface SmartMoneyTrade {
  traderAddress: string;
  traderName?: string;
  conditionId?: string;
  marketSlug?: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  tokenId?: string;
  outcome?: string;
  txHash?: string;
  timestamp: number;
  isSmartMoney: boolean;
  smartMoneyInfo?: SmartMoneyWallet;
}

/**
 * Auto copy trading options
 */
export interface AutoCopyTradingOptions {
  /** Specific wallet addresses to follow */
  targetAddresses?: string[];
  /** Follow top N from leaderboard */
  topN?: number;

  /** Scale factor for size (0.1 = 10%) */
  sizeScale?: number;
  /** Maximum USDC per trade */
  maxSizePerTrade?: number;
  /** Maximum slippage (e.g., 0.03 = 3%) */
  maxSlippage?: number;
  /** Order type: FOK or FAK */
  orderType?: 'FOK' | 'FAK';
  /** Delay before executing (ms) */
  delay?: number;

  /** Minimum trade value to copy (USDC) */
  minTradeSize?: number;
  /** Only copy BUY or SELL trades */
  sideFilter?: 'BUY' | 'SELL';

  /** Dry run mode */
  dryRun?: boolean;

  /** Callbacks */
  onTrade?: (trade: SmartMoneyTrade, result: OrderResult) => void;
  onError?: (error: Error) => void;
}

/**
 * Auto copy trading statistics
 */
export interface AutoCopyTradingStats {
  startTime: number;
  tradesDetected: number;
  tradesExecuted: number;
  tradesSkipped: number;
  tradesFailed: number;
  totalUsdcSpent: number;
}

/**
 * Auto copy trading subscription
 */
export interface AutoCopyTradingSubscription {
  id: string;
  targetAddresses: string[];
  startTime: number;
  isActive: boolean;
  stats: AutoCopyTradingStats;
  stop: () => void;
  getStats: () => AutoCopyTradingStats;
}

/**
 * Service configuration
 */
export interface SmartMoneyServiceConfig {
  /** Minimum PnL to be considered Smart Money (default: $1000) */
  minPnl?: number;
  /** Cache TTL (default: 300000 = 5 min) */
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

  private smartMoneyCache: Map<string, SmartMoneyWallet> = new Map();
  private smartMoneySet: Set<string> = new Set();
  private cacheTimestamp: number = 0;

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
      cacheTtl: config.cacheTtl ?? 300000,
    };
  }

  // ============================================================================
  // Smart Money Info
  // ============================================================================

  /**
   * Get list of Smart Money wallets from leaderboard
   */
  async getSmartMoneyList(limit: number = 100): Promise<SmartMoneyWallet[]> {
    if (this.isCacheValid()) {
      return Array.from(this.smartMoneyCache.values());
    }

    const leaderboardPage = await this.walletService.getLeaderboard(0, limit);
    const entries = leaderboardPage.entries;

    const smartMoneyList: SmartMoneyWallet[] = [];

    for (let i = 0; i < entries.length; i++) {
      const trader = entries[i];
      if (trader.pnl < this.config.minPnl) continue;

      const wallet: SmartMoneyWallet = {
        address: trader.address.toLowerCase(),
        name: trader.userName,
        pnl: trader.pnl,
        volume: trader.volume,
        score: Math.min(100, Math.round((trader.pnl / 100000) * 50 + (trader.volume / 1000000) * 50)),
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
    const normalized = address.toLowerCase();
    if (this.isCacheValid()) {
      return this.smartMoneySet.has(normalized);
    }
    await this.getSmartMoneyList();
    return this.smartMoneySet.has(normalized);
  }

  /**
   * Get Smart Money info for an address
   */
  async getSmartMoneyInfo(address: string): Promise<SmartMoneyWallet | null> {
    const normalized = address.toLowerCase();
    if (this.isCacheValid() && this.smartMoneyCache.has(normalized)) {
      return this.smartMoneyCache.get(normalized)!;
    }
    await this.getSmartMoneyList();
    return this.smartMoneyCache.get(normalized) || null;
  }

  // ============================================================================
  // Trade Subscription - 监听交易
  // ============================================================================

  /**
   * Subscribe to trades from specific addresses
   *
   * @example
   * ```typescript
   * const sub = smartMoneyService.subscribeSmartMoneyTrades(
   *   (trade) => {
   *     console.log(`${trade.traderName} ${trade.side} ${trade.size} @ ${trade.price}`);
   *   },
   *   { filterAddresses: ['0x1234...', '0x5678...'] }
   * );
   *
   * // Stop listening
   * sub.unsubscribe();
   * ```
   */
  subscribeSmartMoneyTrades(
    onTrade: (trade: SmartMoneyTrade) => void,
    options: {
      filterAddresses?: string[];
      minSize?: number;
      smartMoneyOnly?: boolean;
    } = {}
  ): { id: string; unsubscribe: () => void } {
    this.tradeHandlers.add(onTrade);

    // Ensure cache is populated
    this.getSmartMoneyList().catch(() => {});

    // Start subscription if not active
    if (!this.activeSubscription) {
      this.activeSubscription = this.realtimeService.subscribeAllActivity({
        onTrade: (activityTrade: ActivityTrade) => {
          this.handleActivityTrade(activityTrade, options);
        },
        onError: (error) => {
          console.error('[SmartMoneyService] Subscription error:', error);
        },
      });
    }

    return {
      id: `smart_money_${Date.now()}`,
      unsubscribe: () => {
        this.tradeHandlers.delete(onTrade);
        if (this.tradeHandlers.size === 0 && this.activeSubscription) {
          this.activeSubscription.unsubscribe();
          this.activeSubscription = null;
        }
      },
    };
  }

  private async handleActivityTrade(
    trade: ActivityTrade,
    options: { filterAddresses?: string[]; minSize?: number; smartMoneyOnly?: boolean }
  ): Promise<void> {
    const rawAddress = trade.trader?.address;
    if (!rawAddress) return;

    const traderAddress = rawAddress.toLowerCase();

    // Address filter
    if (options.filterAddresses && options.filterAddresses.length > 0) {
      const normalized = options.filterAddresses.map(a => a.toLowerCase());
      if (!normalized.includes(traderAddress)) return;
    }

    // Size filter
    if (options.minSize && trade.size < options.minSize) return;

    // Smart Money filter
    const isSmartMoney = this.smartMoneySet.has(traderAddress);
    if (options.smartMoneyOnly && !isSmartMoney) return;

    const smartMoneyTrade: SmartMoneyTrade = {
      traderAddress,
      traderName: trade.trader?.name,
      conditionId: trade.conditionId,
      marketSlug: trade.marketSlug,
      side: trade.side,
      size: trade.size,
      price: trade.price,
      tokenId: trade.asset,
      outcome: trade.outcome,
      txHash: trade.transactionHash,
      timestamp: trade.timestamp,
      isSmartMoney,
      smartMoneyInfo: this.smartMoneyCache.get(traderAddress),
    };

    for (const handler of this.tradeHandlers) {
      try {
        handler(smartMoneyTrade);
      } catch (error) {
        console.error('[SmartMoneyService] Handler error:', error);
      }
    }
  }

  // ============================================================================
  // Auto Copy Trading - 自动跟单
  // ============================================================================

  /**
   * Start auto copy trading - 自动跟单
   *
   * @example
   * ```typescript
   * const sub = await smartMoneyService.startAutoCopyTrading({
   *   targetAddresses: ['0x1234...'],
   *   // 或者跟踪排行榜前N名
   *   topN: 10,
   *
   *   sizeScale: 0.1,        // 10%
   *   maxSizePerTrade: 50,   // $50
   *   maxSlippage: 0.03,     // 3%
   *   orderType: 'FOK',
   *
   *   dryRun: true,          // 测试模式
   *
   *   onTrade: (trade, result) => console.log(result),
   * });
   *
   * // 停止
   * sub.stop();
   * ```
   */
  async startAutoCopyTrading(options: AutoCopyTradingOptions): Promise<AutoCopyTradingSubscription> {
    const startTime = Date.now();

    // Build target list
    let targetAddresses: string[] = [];

    if (options.targetAddresses?.length) {
      targetAddresses = options.targetAddresses.map(a => a.toLowerCase());
    }

    if (options.topN && options.topN > 0) {
      const smartMoneyList = await this.getSmartMoneyList(options.topN);
      const topAddresses = smartMoneyList.map(w => w.address);
      targetAddresses = [...new Set([...targetAddresses, ...topAddresses])];
    }

    if (targetAddresses.length === 0) {
      throw new Error('No target addresses. Use targetAddresses or topN.');
    }

    // Stats
    const stats: AutoCopyTradingStats = {
      startTime,
      tradesDetected: 0,
      tradesExecuted: 0,
      tradesSkipped: 0,
      tradesFailed: 0,
      totalUsdcSpent: 0,
    };

    // Config
    const sizeScale = options.sizeScale ?? 0.1;
    const maxSizePerTrade = options.maxSizePerTrade ?? 50;
    const maxSlippage = options.maxSlippage ?? 0.03;
    const orderType = options.orderType ?? 'FOK';
    const minTradeSize = options.minTradeSize ?? 10;
    const sideFilter = options.sideFilter;
    const delay = options.delay ?? 0;
    const dryRun = options.dryRun ?? false;

    // Subscribe
    const subscription = this.subscribeSmartMoneyTrades(
      async (trade: SmartMoneyTrade) => {
        stats.tradesDetected++;

        try {
          // Check target
          if (!targetAddresses.includes(trade.traderAddress.toLowerCase())) {
            return;
          }

          // Filters
          const tradeValue = trade.size * trade.price;
          if (tradeValue < minTradeSize) {
            stats.tradesSkipped++;
            return;
          }

          if (sideFilter && trade.side !== sideFilter) {
            stats.tradesSkipped++;
            return;
          }

          // Calculate size
          let copySize = trade.size * sizeScale;
          let copyValue = copySize * trade.price;

          // Enforce max size
          if (copyValue > maxSizePerTrade) {
            copySize = maxSizePerTrade / trade.price;
            copyValue = maxSizePerTrade;
          }

          // Polymarket minimum order is $1
          const MIN_ORDER_SIZE = 1;
          if (copyValue < MIN_ORDER_SIZE) {
            stats.tradesSkipped++;
            return;
          }

          // Delay
          if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
          }

          // Token
          const tokenId = trade.tokenId;
          if (!tokenId) {
            stats.tradesSkipped++;
            return;
          }

          // Price with slippage
          const slippagePrice = trade.side === 'BUY'
            ? trade.price * (1 + maxSlippage)
            : trade.price * (1 - maxSlippage);

          const usdcAmount = copyValue; // Already calculated above

          // Execute
          let result: OrderResult;

          if (dryRun) {
            result = { success: true, orderId: `dry_run_${Date.now()}` };
            console.log('[DRY RUN]', {
              trader: trade.traderAddress.slice(0, 10),
              side: trade.side,
              market: trade.marketSlug,
              copy: { size: copySize.toFixed(2), usdc: usdcAmount.toFixed(2) },
            });
          } else {
            result = await this.tradingService.createMarketOrder({
              tokenId,
              side: trade.side,
              amount: usdcAmount,
              price: slippagePrice,
              orderType,
            });
          }

          if (result.success) {
            stats.tradesExecuted++;
            stats.totalUsdcSpent += usdcAmount;
          } else {
            stats.tradesFailed++;
          }

          options.onTrade?.(trade, result);
        } catch (error) {
          stats.tradesFailed++;
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      },
      { filterAddresses: targetAddresses, minSize: minTradeSize }
    );

    return {
      id: subscription.id,
      targetAddresses,
      startTime,
      isActive: true,
      stats,
      stop: () => subscription.unsubscribe(),
      getStats: () => ({ ...stats }),
    };
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private isCacheValid(): boolean {
    return Date.now() - this.cacheTimestamp < this.config.cacheTtl && this.smartMoneyCache.size > 0;
  }

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
