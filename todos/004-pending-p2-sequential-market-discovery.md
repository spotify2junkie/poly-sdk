---
status: pending
priority: p2
issue_id: 004
tags:
  - code-review
  - performance
  - network
  - api
dependencies: []
---

# Problem Statement

The market discovery mechanism makes **sequential HTTP requests** to the Polymarket API, waiting for each request to complete before starting the next. This causes slow application startup and market refresh (600-3000ms).

When markets need to be refreshed every 15 minutes, these delays accumulate and cause the bot to miss trading opportunities during the discovery window.

## Findings

**Location:** `examples/tui-trading-bot.ts:349-381`

```typescript
// Sequential requests - each waits for the previous one
for (let offset = 0; offset <= 2; offset++) {
  const timestamp = windowStart + (offset * 900);
  const expectedSlug = `${token}-updown-15m-${timestamp}`;

  const response = await fetch(`https://gamma-api.polymarket.com/markets?slug=${expectedSlug}`);
  const data = await response.json();
  // ... check if market found
}
```

**Performance Impact:**
- Best case: 1 successful request = ~100ms
- Worst case: 3 sequential requests = ~3000ms
- Average: ~500-1500ms per market discovery
- Both BTC and ETH discovered in parallel, so total time = 1-3 seconds

**User Impact:**
- Slow application startup
- Missed trading opportunities during refresh
- Poor user experience during market transitions

---

# Proposed Solutions

## Solution 1: Parallel Requests with Promise.all (RECOMMENDED)

**Description:** Fetch all 3 time windows concurrently and return the first valid market found.

**Pros:**
- 3-6x faster discovery
- No change in functionality
- Simple implementation

**Cons:**
- Slightly more network traffic (3 requests instead of 1-2)
- Need to handle partial failures

**Effort:** Small (30 minutes)
**Risk:** Low

**Implementation:**
```typescript
async function discoverMarket(token: 'btc' | 'eth'): Promise<MarketData | null> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / 900) * 900;

    // Fetch all 3 offsets in parallel
    const requests = [];
    for (let offset = 0; offset <= 2; offset++) {
      const timestamp = windowStart + (offset * 900);
      const expectedSlug = `${token}-updown-15m-${timestamp}`;
      requests.push(
        fetch(`https://gamma-api.polymarket.com/markets?slug=${expectedSlug}`)
          .then(r => r.json())
      );
    }

    const results = await Promise.all(requests);

    // Find first valid market
    for (const data of results) {
      if (data?.[0]) {
        const market = data[0];
        // ... validate and return
      }
    }

    return null;
  } catch (error) {
    console.error(`✗ ${token.toUpperCase()} discovery failed:`, (error as Error).message);
    return null;
  }
}
```

---

## Solution 2: Add Request Caching

**Description:** Cache market discovery results for 30 seconds to avoid repeated requests.

**Pros:**
- Eliminates redundant API calls
- Faster subsequent discoveries
- Reduced API load

**Cons:**
- Could return stale market data
- Adds cache complexity
- May miss newly created markets

**Effort:** Medium (1 hour)
**Risk:** Medium

---

## Solution 3: Optimize Search Order

**Description:** Start with offset 0 (current window) first before checking future windows, since current market is most likely to be found.

**Pros:**
- No code complexity
- Improves average case
- Maintains sequential approach

**Cons:**
- Still slower than parallel
- Worst case unchanged

**Effort:** Trivial (5 minutes)
**Risk:** Low

---

# Recommended Action

**Use Solution 1** - Parallel Requests with Promise.all

This provides the most significant performance improvement with minimal risk. The 3-6x speedup is substantial and immediately noticeable to users.

**Acceptance Criteria:**
- [ ] Market discovery uses parallel requests
- [ ] Discovery time reduced to ≤500ms (from 600-3000ms)
- [ ] Error handling for partial failures
- [ ] No behavior change in successful cases

---

# Technical Details

**Affected Files:**
- `examples/tui-trading-bot.ts` (lines 344-387)

**Components:**
- Market discovery logic
- API fetching
- Async request handling

**Database Changes:** None

**Breaking Changes:** None

---

# Work Log

**2026-01-03** - Issue identified during performance review
- Sequential requests confirmed as bottleneck
- Measured 600-3000ms discovery time
- Marked as P2 (important) for performance improvement
