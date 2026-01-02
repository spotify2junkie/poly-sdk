---
status: pending
priority: p2
issue_id: 006
tags:
  - code-review
  - security
  - input-validation
  - error-handling
dependencies: []
---

# Problem Statement

The application uses **external API data without proper validation**. Data from the Polymarket API (JSON responses, token IDs) is used directly in critical operations without format checking, length validation, or sanitization.

This exposes the application to:
- Prototype pollution via malicious JSON
- DoS via malformed JSON
- WebSocket subscription poisoning
- Type confusion crashes
- Invalid trading decisions based on bad data

## Findings

### Critical Validation Gaps

**1. Unsafe JSON.parse() (Line 362)**
```typescript
const tokenIds = JSON.parse(market.clobTokenIds || '[]');
if (tokenIds.length >= 2) {
  return {
    yesTokenId: tokenIds[0],  // No validation
    noTokenId: tokenIds[1],   // No validation
```

**Risks:**
- Prototype pollution if API is compromised
- Array could contain non-string values
- Token IDs could be malicious

**2. Unvalidated WebSocket Token IDs (Lines 424-435, 544-555, 559-570)**
```typescript
sdk.realtime.subscribeMarket(
  newMarket.yesTokenId,  // No format validation
  newMarket.noTokenId,   // No length check
```

**Risks:**
- Could subscribe to wrong channels
- Extremely long IDs cause memory issues
- Special characters break WebSocket protocol

**3. Unvalidated Environment Variables (Lines 21-23)**
```typescript
const ENTRY_MIN = parseFloat(process.env.ENTRY_MIN || '0.10');
const ENTRY_MAX = parseFloat(process.env.ENTRY_MAX || '0.25');
```

**Risks:**
- NaN or Infinity not checked
- Negative values not rejected
- ENTRY_MIN >= ENTRY_MAX not validated
- Could cause inverted trading logic

---

# Proposed Solutions

## Solution 1: Add Input Validation Layer (RECOMMENDED)

**Description:** Create validation functions for all external inputs (API data, environment variables, WebSocket messages).

**Pros:**
- Comprehensive protection
- Clear error messages
- Easy to extend
- Catches issues early

**Cons:**
- More code to maintain
- Slight performance overhead

**Effort:** Medium (2-3 hours)
**Risk:** Low

**Implementation:**
```typescript
// Environment variable validation
function validateEnvNumber(
  name: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const value = process.env[name];
  if (value === undefined) return defaultValue;

  const parsed = parseFloat(value);
  if (isNaN(parsed) || !isFinite(parsed)) {
    throw new Error(`${name}: Must be a valid number`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${name}: Must be between ${min} and ${max}`);
  }
  return parsed;
}

const ENTRY_MIN = validateEnvNumber('ENTRY_MIN', 0.10, 0, 1);
const ENTRY_MAX = validateEnvNumber('ENTRY_MAX', 0.25, 0, 1);
if (ENTRY_MIN >= ENTRY_MAX) {
  throw new Error('ENTRY_MIN must be less than ENTRY_MAX');
}

// Token ID validation
function validateTokenId(tokenId: string, context: string): void {
  if (typeof tokenId !== 'string') {
    throw new Error(`${context}: Token ID must be a string`);
  }
  if (tokenId.length < 10 || tokenId.length > 100) {
    throw new Error(`${context}: Token ID length invalid`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(tokenId)) {
    throw new Error(`${context}: Token ID contains invalid characters`);
  }
}

// JSON parsing with schema validation
function validateTokenIds(input: unknown): string[] {
  if (!input || typeof input !== 'string') {
    throw new Error('Invalid clobTokenIds format');
  }
  const parsed = JSON.parse(input) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 2) {
    throw new Error('clobTokenIds must be an array with 2+ elements');
  }
  return parsed.map((id, i) => {
    if (typeof id !== 'string') {
      throw new Error(`Token ID at index ${i} is not a string`);
    }
    return id;
  });
}
```

---

## Solution 2: Use Zod or Similar Schema Library

**Description:** Use a schema validation library (Zod, Joi, Yup) for declarative validation.

**Pros:**
- Declarative and readable
- Comprehensive error messages
- Industry standard approach
- TypeScript integration

**Cons:**
- Additional dependency
- Learning curve for team
- May be overkill for simple validation

**Effort:** Medium (2-3 hours)
**Risk:** Low

---

## Solution 3: Minimal Type Guards

**Description:** Add basic type guards without full validation layer.

**Pros:**
- Minimal code changes
- No new dependencies
- TypeScript-friendly

**Cons:**
- Less comprehensive protection
- Still vulnerable to edge cases
- Doesn't enforce business rules

**Effort:** Small (1 hour)
**Risk:** Medium (limited protection)

---

# Recommended Action

**Use Solution 1** - Add Input Validation Layer

Since this handles real trading decisions, proper validation is critical. The validation layer provides:

1. **Comprehensive protection** - Covers all input vectors
2. **Clear error messages** - Easy to debug issues
3. **No dependencies** - Pure TypeScript
4. **Reusable patterns** - Can be applied to SDK

**Acceptance Criteria:**
- [ ] All environment variables validated with ranges
- [ ] Token IDs validated before WebSocket subscription
- [ ] API responses validated before use
- [ ] Clear error messages for invalid inputs
- [ ] Application fails fast on bad data
- [ ] No crashes from malformed input

---

# Technical Details

**Affected Files:**
- `examples/tui-trading-bot.ts` (lines 21-23, 362-363, 424-435, 544-555, 559-570)

**Components:**
- Input validation
- Error handling
- Type safety

**Database Changes:** None

**Breaking Changes:** None (internal validation)

---

# Work Log

**2026-01-03** - Issue identified during security and TypeScript reviews
- Unsafe JSON.parse() confirmed
- Unvalidated env vars confirmed
- Unvalidated token IDs confirmed
- Marked as P2 (important) for security and reliability
