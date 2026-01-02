---
status: pending
priority: p2
issue_id: 005
tags:
  - code-review
  - architecture
  - maintainability
  - refactoring
dependencies: []
---

# Problem Statement

The TUI trading bot is a **604-line monolithic file** that combines multiple responsibilities (UI rendering, business logic, state management, networking, trading logic). This violates the Single Responsibility Principle and makes the code:

- Difficult to test (no separation of concerns)
- Hard to maintain (everything is coupled)
- Impossible to reuse (UI and business logic are intertwined)
- Complex to understand (7+ distinct responsibilities in one file)

The file serves as an example/demo but demonstrates poor architectural patterns that could mislead users.

## Findings

### Architectural Violations

**1. Single Responsibility Principle - VIOLATED**
- UI component creation (lines 77-205)
- State management (lines 52-75)
- Market discovery (lines 344-387)
- WebSocket subscription (lines 512-583)
- Trading logic (not implemented but prepared)
- Market refresh (lines 390-452)
- Orderbook processing (lines 454-500)

**2. Separation of Concerns - VIOLATED**
```typescript
// Business logic directly manipulates UI
function processOrderbook(book: OrderbookSnapshot, market: MarketData) {
  market.bids = bids;
  market.asks = asks;
  // ... business logic ...

  // Directly calls UI updates
  if (market.token === 'BTC') {
    updateSignalBox(btcSignalBox, market, 'BTC');
    updateOrderBook(btcOrderBookBox, market, 'BTC');
  }
}
```

**3. Global Mutable State**
```typescript
const state: {
  markets: { btc: MarketData | null; eth: MarketData | null };
  sdk: PolymarketSDK | null;
  updateCounts: { btc: number; eth: number };
  subscriptions: { btc: { yes: string; no: string } | null; eth: ... };
  trades: Trade[];
  totalPnl: number;
} = { /* ... */ };
```

**Problems:**
- No encapsulation
- Direct mutation throughout
- Difficult to reason about state changes
- Impossible to implement undo/redo

**4. Hard-coded Values Limit Extensibility**
- Only supports BTC/ETH (hard-coded types)
- Fixed UI layout (can't adapt to screen size)
- Hard-coded refresh thresholds

---

# Proposed Solutions

## Solution 1: Extract into Module Structure (RECOMMENDED)

**Description:** Split the monolithic file into focused modules with clear responsibilities.

**Pros:**
- Each module has single responsibility
- Easy to test individual components
- Business logic can be reused with different UIs
- Follows Node.js/TypeScript best practices
- Better organization for future enhancements

**Cons:**
- More files to manage
- Initial refactoring effort
- May seem like "overkill" for a simple example

**Effort:** Medium (4-6 hours)
**Risk:** Low

**Proposed Structure:**
```
examples/tui-trading-bot/
├── index.ts              # Entry point
├── config.ts              # Configuration
├── state/                 # State management
│   └── store.ts
├── core/                  # Business logic
│   ├── market-discovery.ts
│   ├── orderbook-processor.ts
│   └── position-manager.ts
├── ui/                    # UI components
│   ├── components.ts
│   ├── layout.ts
│   └── theme.ts
└── types.ts               # Shared types
```

---

## Solution 2: Minimal Refactoring - Extract Functions

**Description:** Keep single file but extract pure functions from UI code.

**Pros:**
- Less invasive change
- Maintains "simple example" feel
- Easier to test business logic
- Still single-file deployment

**Cons:**
- Still has tight coupling
- Limited reusability
- Doesn't address root architectural issues

**Effort:** Small (2 hours)
**Risk:** Low

---

## Solution 3: Create Class-Based Architecture

**Description:** Organize code into classes (TradingBot, UIManager, MarketManager, etc.)

**Pros:**
- Clear encapsulation
- State management through class instances
- Easy to understand OOP structure

**Cons:**
- More boilerplate
- May feel "heavy" for a simple example
- Different from SDK's functional patterns

**Effort:** Medium (3-4 hours)
**Risk:** Low

---

# Recommended Action

**Use Solution 1** - Extract into Module Structure

Since this is an example file that users will learn from, it's important to demonstrate good architectural patterns. The modular structure:

1. **Teaches best practices** - Users see proper separation
2. **Enables testing** - Each module can be unit tested
3. **Allows extensibility** - Easy to add new markets or UI backends
4. **Follows SDK patterns** - The SDK itself uses modular architecture

**For a minimal example,** create a simplified version with Solution 2.

**Acceptance Criteria:**
- [ ] UI code separated from business logic
- [ ] State encapsulated in store module
- [ ] Pure functions for market operations
- [ ] Each module has clear, single purpose
- [ ] Example still runnable as single command

---

# Technical Details

**Affected Files:**
- `examples/tui-trading-bot.ts` (entire file)

**Components:**
- Code organization
- Module structure
- Separation of concerns

**Database Changes:** None

**Breaking Changes:** None (internal refactoring)

---

# Work Log

**2026-01-03** - Issue identified during architecture review
- Monolithic 604-line file confirmed
- 7+ responsibilities identified
- SRP and SoC violations confirmed
- Marked as P2 (important) for maintainability
