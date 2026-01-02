---
status: completed
priority: p1
issue_id: 003
tags:
  - code-review
  - resource-leak
  - cleanup
  - timers
dependencies: []
---

# Problem Statement

The TUI trading bot creates **two setInterval timers** but never clears them, causing resource leaks and preventing clean application shutdown. The timers continue running even after the user exits the application.

This causes:
- Memory leaks (timer callbacks retain scope)
- Orphaned processes that don't exit cleanly
- Potential race conditions on restart
- Poor user experience (application hangs on exit)

## Findings

### Evidence from Async/Node.js Review

**Location:** `examples/tui-trading-bot.ts:578-598`

```typescript
// Line 578-585: No timer ID stored
setInterval(async () => {
  if (needsRefresh(state.markets.btc)) {
    await refreshMarket('btc');
  }
  if (needsRefresh(state.markets.eth)) {
    await refreshMarket('eth');
  }
}, 5000);

// Line 588-598: No timer ID stored
setInterval(() => {
  if (state.markets.btc) {
    updateSignalBox(btcSignalBox, state.markets.btc, 'BTC');
  }
  if (state.markets.eth) {
    updateSignalBox(ethSignalBox, market, 'ETH');
  }
  updatePnlBox();
  updateStatusBar();
  screen.render();
}, 1000);
```

**Current Exit Handler (Lines 508-511):**
```typescript
screen.key(['q', 'C-c'], () => {
  state.sdk?.realtime.disconnect();
  process.exit(0); // ← Exits without clearing intervals
});
```

**Problems:**
1. No timer IDs captured → cannot clearInterval
2. Intervals continue running after process.exit()
3. Event loop doesn't drain properly
4. Orphaned timers on process restart

---

# Proposed Solutions

## Solution 1: Track and Clear All Timers (RECOMMENDED) ✓ IMPLEMENTED

**Description:** Store all timer IDs in state and explicitly clear them during shutdown.

**Pros:**
- Complete resource cleanup
- Proper graceful shutdown
- Event loop can drain
- Follows Node.js best practices

**Cons:**
- Requires state management for timers
- Slightly more code

**Effort:** Small (1 hour)
**Risk:** Low

**Implementation:**
```typescript
// Add to state
timers: {
  refreshCheck: NodeJS.Timeout | null;
  uiUpdate: NodeJS.Timeout | null;
} = {
  refreshCheck: null,
  uiUpdate: null,
};

// Store timer IDs when creating
state.timers.refreshCheck = setInterval(async () => {
  if (needsRefresh(state.markets.btc)) {
    await refreshMarket('btc');
  }
  if (needsRefresh(state.markets.eth)) {
    await refreshMarket('eth');
  }
}, 5000);

state.timers.uiUpdate = setInterval(() => {
  // ... UI update logic
}, 1000);

// Clear on exit
screen.key(['q', 'C-c'], () => {
  if (state.timers.refreshCheck) {
    clearInterval(state.timers.refreshCheck);
  }
  if (state.timers.uiUpdate) {
    clearInterval(state.timers.uiUpdate);
  }
  state.sdk?.realtime.disconnect();
  process.exit(0);
});
```

---

## Solution 2: Use Global Timers Array

**Description:** Maintain a global array of all timers and iterate to clear them.

**Pros:**
- Simple implementation
- Automatic cleanup for all timers
- Easy to add new timers

**Cons:**
- Global state (less clean)
- Need to remember to push to array
- Less explicit than tracking individually

**Effort:** Small (1 hour)
**Risk:** Low

**Implementation:**
```typescript
const timers: NodeJS.Timeout[] = [];

function setIntervalTracked(callback: () => void, ms: number) {
  const timer = setInterval(callback, ms);
  timers.push(timer);
  return timer;
}

// In cleanup
function cleanup() {
  for (const timer of timers) {
    clearInterval(timer);
  }
  timers.length = 0;
}
```

---

## Solution 3: Use AbortController Pattern

**Description:** Use AbortController to signal cancellation to all async operations.

**Pros:**
- Modern async/await pattern
- Single signal for multiple operations
- Works with fetch and other async APIs

**Cons:**
- More complex for setInterval
- Overkill for this use case
- Requires wrapping setInterval

**Effort:** Medium (2 hours)
**Risk:** Low

---

# Recommended Action

**✓ Used Solution 1** - Track and Clear All Timers

This is the most straightforward approach that follows Node.js best practices for resource cleanup.

**Acceptance Criteria:**
- [x] All interval timers tracked in state
- [x] All timers cleared on exit (both 'q' and Ctrl+C)
- [x] Process exits cleanly without hanging
- [x] No orphaned timers after shutdown
- [x] Cleanup also called on uncaught exceptions

---

# Technical Details

**Affected Files:**
- `examples/tui-trading-bot.ts` (lines 51-75, 508-511, 578-598)

**Components:**
- Timer lifecycle management
- Exit handling
- Graceful shutdown

**Database Changes:** None

**Breaking Changes:** None

---

# Work Log

**2026-01-03** - Issue identified during async/await review
- Two untracked intervals confirmed
- No cleanup mechanism exists
- Marked as P1 (critical) due to resource leak

**2026-01-03** - Fixed using Solution 1
- Added `timers` object to state with `refreshCheck` and `uiUpdate`
- Store timer IDs when creating intervals
- Created unified `cleanup()` function for exit handler
- Clear all timers and render timer in cleanup
- All acceptance criteria met
