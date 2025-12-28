/**
 * TradingService Integration Tests
 *
 * Tests the TradingService for trading operations.
 * Note: Market data methods have been moved to MarketService.
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { TradingService } from '../../services/trading-service.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { createUnifiedCache } from '../../core/unified-cache.js';

describe('TradingService Integration', () => {
  let service: TradingService;
  let testYesTokenId: string;

  beforeAll(async () => {
    // Create service with a dummy private key for read-only operations
    service = new TradingService(new RateLimiter(), createUnifiedCache(), {
      privateKey: '0x' + '1'.repeat(64), // Dummy key for read-only
    });

    // Initialize the service
    await service.initialize();

    // Find a liquid market for testing
    const response = await fetch(
      'https://clob.polymarket.com/markets?limit=1'
    );
    const result = await response.json() as { data: Array<{ tokens: Array<{ token_id: string; outcome: string }> }> };

    if (result.data.length === 0) {
      throw new Error('No markets found for testing');
    }

    const yesToken = result.data[0].tokens.find((t: { outcome: string }) => t.outcome === 'Yes');
    if (!yesToken) {
      throw new Error('No YES token found');
    }

    testYesTokenId = yesToken.token_id;
  }, 60000);

  describe('getTickSize', () => {
    it('should return valid tick size', async () => {
      const tickSize = await service.getTickSize(testYesTokenId);

      expect(typeof tickSize).toBe('string');
      expect(['0.01', '0.001', '0.0001']).toContain(tickSize);

      console.log(`✓ getTickSize: ${tickSize}`);
    }, 30000);
  });

  describe('service state', () => {
    it('should report initialized status', () => {
      expect(service.isInitialized()).toBe(true);
    });

    it('should have a wallet address', () => {
      const address = service.getAddress();
      expect(typeof address).toBe('string');
      expect(address.startsWith('0x')).toBe(true);
      expect(address.length).toBe(42);

      console.log(`✓ Wallet address: ${address.slice(0, 10)}...`);
    });
  });
});
