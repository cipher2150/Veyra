const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'split_ledger.db');
const db = new Database(dbPath);

// Enable foreign keys and WAL mode for reliability
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'roommates', -- roommates, trip, colleagues, other
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(group_id, user_id)
    );

    -- Transactions: Immutable financial events
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
      type TEXT NOT NULL, -- 'EXPENSE', 'SETTLEMENT', 'REVERSAL'
      description TEXT NOT NULL,
      amount_paise INTEGER NOT NULL, -- Total positive event amount in paise
      split_type TEXT, -- 'EQUAL', 'EXACT', 'PERCENTAGE', 'SHARES', or NULL
      created_by INTEGER NOT NULL REFERENCES users(id),
      reversal_of_id INTEGER REFERENCES transactions(id),
      is_reversed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Double-Entry Ledger Entries (Postings)
    -- Invariant: For any transaction_id, SUM(amount_paise) == 0
    -- Positive amount_paise = Credit (asset claim / paid expense on behalf of others / receiving settlement)
    -- Negative amount_paise = Debit (liability / consumed share / paying settlement)
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount_paise INTEGER NOT NULL,
      entry_type TEXT NOT NULL, -- 'PAYER_CREDIT', 'EXPENSE_SHARE_DEBIT', 'SETTLEMENT_PAYMENT', 'SETTLEMENT_RECEIPT', 'REVERSAL_ENTRY'
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Activity log for audit & group event tracking
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Idempotency keys store
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      path TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_group_user ON ledger_entries(group_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_tx ON ledger_entries(transaction_id);
    CREATE INDEX IF NOT EXISTS idx_tx_group ON transactions(group_id);
    CREATE INDEX IF NOT EXISTS idx_activity_group ON activity_logs(group_id);
  `);
}

initDb();

module.exports = db;
