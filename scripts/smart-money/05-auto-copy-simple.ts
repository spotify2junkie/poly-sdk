/**
 * Auto Copy Trading (Simplified) - 使用 PolymarketSDK 简化初始化
 *
 * 对比 04-auto-copy-trading.ts，这里只需要一行初始化 SDK
 *
 * 运行：pnpm exec tsx scripts/smart-money/05-auto-copy-simple.ts
 */

import 'dotenv/config';
import { PolymarketSDK } from '../../src/index.js';

// Configuration
const DRY_RUN = true;
const TOP_N = 50;
const RUN_DURATION_MS = 60 * 1000; // 1 minute

async function main() {
  console.log('='.repeat(60));
  console.log('🤖 Auto Copy Trading (Simplified SDK)');
  console.log('='.repeat(60));

  const privateKey = process.env.PRIVATE_KEY || process.env.POLY_PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ PRIVATE_KEY not found');
    process.exit(1);
  }

  // ✅ 一行初始化 - 所有服务自动创建
  const sdk = new PolymarketSDK({ privateKey });

  console.log('\n[WebSocket] 连接中...');
  sdk.connect();
  await sdk.waitForConnection();
  console.log('  ✅ Connected');

  // ✅ 直接使用 sdk.smartMoney
  const subscription = await sdk.smartMoney.startAutoCopyTrading({
    topN: TOP_N,
    sizeScale: 0.1,
    maxSizePerTrade: 10,
    maxSlippage: 0.03,
    orderType: 'FOK',
    minTradeSize: 5,
    dryRun: DRY_RUN,
    onTrade: (trade, result) => {
      console.log(`\n📈 ${trade.traderName || trade.traderAddress.slice(0, 10)}...`);
      console.log(`   ${trade.side} ${trade.outcome} @ $${trade.price.toFixed(4)}`);
      console.log(`   Result: ${result.success ? '✅' : '❌'}`);
    },
  });

  console.log(`\n✅ 跟踪 ${subscription.targetAddresses.length} 个钱包`);
  console.log('⏳ 监听中...\n');

  // Run for duration
  await new Promise(resolve => setTimeout(resolve, RUN_DURATION_MS));

  // Stats
  const stats = subscription.getStats();
  console.log('\n' + '='.repeat(60));
  console.log(`检测: ${stats.tradesDetected}, 执行: ${stats.tradesExecuted}, 跳过: ${stats.tradesSkipped}`);

  // ✅ 一行清理
  subscription.stop();
  sdk.disconnect();

  console.log('✅ Done');
}

main().catch(console.error);
