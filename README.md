# SplitLedger

> **SplitLedger** is a backend service with a minimal, responsive web interface that helps groups track shared expenses and settle up fairly, with the accuracy and auditability of a real payments system.

---

## Key Capabilities & Architecture

### 1. Paise-Level Integer Precision (Zero-Loss Guarantee)
- All monetary amounts are internally represented and stored as **integer paise** (1 INR = 100 paise).
- Eliminates floating-point rounding errors common in standard applications.
- Supports four split models:
  - **Equal (`EQUAL`)**: Distributes base paise, with remainder distributed sequentially across participants.
  - **Exact Amounts (`EXACT`)**: Validates that participant contributions strictly equal the total down to 1 paisa.
  - **Percentages (`PERCENTAGE`)**: Apportions shares using the Hare-Niemeyer (Largest Remainder) method ensuring exact 100% distribution.
  - **Shares (`SHARES`)**: Apportions shares based on positive weights with remainder allocation.

### 2. Immutable Double-Entry Ledger System
- Every financial event (expense or settlement) writes an immutable record to the ledger.
- **Double-Entry Invariant**:
  $$
\sum \text{amount\_paise} = 0
\quad \text{for every transaction}
$$
- **Zero-History Mutation**:
  - Edits and deletions **never mutate or delete existing database rows**.
  - Deletions are executed by creating an immutable `REVERSAL` transaction with negated postings referencing `reversal_of_id`.
  - Edits are executed by posting a reversal of the prior entry, followed by a new transaction for updated values.
  - Historical auditable records are completely preserved.

### 3. Min-Cash-Flow Debt Simplification
- In any group or globally across groups, net member balances are computed directly from ledger entries.
- The debt simplification algorithm runs greedy matching between top debtors and top creditors to minimize total payment transfers needed to clear all balances (at most $N - 1$ transactions for $N$ members).
- Both **Direct Pairwise Debts** and **Simplified Debts** are available.

### 4. Idempotent Settlement API
- Settlement requests accept an `Idempotency-Key` HTTP header (or body field).
- Protects against double payments caused by network timeouts, retried requests, or UI double-clicks.
- Replayed requests return cached transaction responses directly with `X-Cache-Lookup: HIT-IDEMPOTENT`.

### 5. Filterable History, Activity Logs & RFC CSV Export
- Paginated transaction history with filters for `type` (`EXPENSE`, `SETTLEMENT`, `REVERSAL`), date ranges, and text search.
- Group activity logs providing a chronological event audit log.
- 1-click CSV export adhering to standard RFC 4180 formatting.

---

## Getting Started

### Prerequisites
- Node.js (v18+)
- npm (v9+)

### Installation
```bash
npm install
```

### Running Tests
Executes unit tests for paise precision rounding, double-entry invariants, debt simplification, reversals, and HTTP API integration tests:
```bash
npm test
```

### Running the Application
```bash
npm start
```
Open your browser and navigate to:
```
http://localhost:3000
```

---

## API Reference

### Authentication
- `POST /api/auth/register` — Register new user `{ name, email, password }`
- `POST /api/auth/login` — Login `{ email, password }` $\rightarrow$ `{ user, token }`
- `GET /api/auth/me` — Current profile and global net position
- `GET /api/auth/users` — Search registered users by name or email

### Groups
- `POST /api/groups` — Create group `{ name, type }` (`roommates`, `trip`, `colleagues`, `other`)
- `GET /api/groups` — List groups for user with member counts and user's net balance
- `GET /api/groups/:id` — Group details and member balance breakdown
- `POST /api/groups/:id/members` — Add member `{ email }`
- `GET /api/groups/:id/activity` — Chronological group activity logs

### Expenses & Ledger
- `POST /api/expenses` — Record expense `{ groupId, description, amount, splitType, paidByUserId, participants }`
- `GET /api/expenses/:id` — Inspect transaction details and double-entry postings (`entries`)
- `PUT /api/expenses/:id` — Immutably edit expense (creates reversal + new expense)
- `DELETE /api/expenses/:id` — Immutably delete expense (creates reversal transaction)

### Settlements
- `POST /api/settlements` — Record payment `{ groupId, fromUserId, toUserId, amount, notes }`
  - Header: `Idempotency-Key: <unique-token>`

### Balances & Debt Simplification
- `GET /api/balances/group/:id` — Net balances, direct debts, and min-cash-flow simplified debts
- `GET /api/balances/global` — Cross-group consolidated balances and simplified debts

### History & Export
- `GET /api/transactions` — Paginated and filterable transaction history (`page`, `limit`, `groupId`, `type`, `search`)
- `GET /api/export/csv` — Download CSV export (`groupId` optional)
