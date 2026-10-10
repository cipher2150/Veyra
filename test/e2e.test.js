const assert = require('assert');
const { calculateSplits, toPaise, toRupees, recordExpense, recordSettlement, reverseTransaction, editExpense } = require('../ledger');
const { simplifyDebts, getGroupBalances, getPairwiseDebts } = require('../debt_simplification');
const db = require('../db');

function runTests() {
  console.log('🧪 Starting SplitLedger Core Engine & Invariant Verification...\n');

  // Test 1: Paise arithmetic & exact conversions
  console.log('1. Testing Paise Conversions...');
  assert.strictEqual(toPaise(100.5), 10050);
  assert.strictEqual(toPaise('100.50'), 10050);
  assert.strictEqual(toPaise(0.01), 1);
  assert.strictEqual(toRupees(10050), '100.50');
  assert.strictEqual(toRupees(1), '0.01');
  console.log('  ✅ Paise conversions passed.');

  // Test 2: Equal split rounding (e.g. ₹100 split 3 ways -> 33.34, 33.33, 33.33)
  console.log('2. Testing Equal Split Rounding...');
  const eqSplits = calculateSplits(10000, 'EQUAL', [1, 2, 3]);
  assert.strictEqual(eqSplits[1], 3334);
  assert.strictEqual(eqSplits[2], 3333);
  assert.strictEqual(eqSplits[3], 3333);
  const eqSum = eqSplits[1] + eqSplits[2] + eqSplits[3];
  assert.strictEqual(eqSum, 10000, 'Zero paise lost or created in equal split');
  console.log('  ✅ Equal split passed: sum exactly 10000 paise (₹100.00).');

  // Test 3: Percentage split rounding (Hare-Niemeyer largest-remainder method)
  console.log('3. Testing Percentage Split Rounding...');
  // ₹100 split 33.33%, 33.33%, 33.34%
  const pctSplits = calculateSplits(10000, 'PERCENTAGE', [
    { userId: 1, percentage: 33.33 },
    { userId: 2, percentage: 33.33 },
    { userId: 3, percentage: 33.34 },
  ]);
  const pctSum = pctSplits[1] + pctSplits[2] + pctSplits[3];
  assert.strictEqual(pctSum, 10000);
  console.log('  ✅ Percentage split passed: sum exactly 10000 paise (₹100.00).');

  // Test 4: Shares split rounding
  console.log('4. Testing Shares Split Rounding...');
  // ₹100 split by 2 shares, 1 share, 1 share (total 4 shares -> 50, 25, 25)
  const shareSplits = calculateSplits(10000, 'SHARES', [
    { userId: 1, shares: 2 },
    { userId: 2, shares: 1 },
    { userId: 3, shares: 1 },
  ]);
  assert.strictEqual(shareSplits[1], 5000);
  assert.strictEqual(shareSplits[2], 2500);
  assert.strictEqual(shareSplits[3], 2500);
  console.log('  ✅ Shares split passed: sum exactly 10000 paise (₹100.00).');

  // Test 5: Exact split validation
  console.log('5. Testing Exact Split Validation...');
  const exactSplits = calculateSplits(15000, 'EXACT', [
    { userId: 1, amount: '60.00' },
    { userId: 2, amount: '90.00' },
  ]);
  assert.strictEqual(exactSplits[1], 6000);
  assert.strictEqual(exactSplits[2], 9000);
  assert.throws(() => {
    calculateSplits(15000, 'EXACT', [
      { userId: 1, amount: '60.00' },
      { userId: 2, amount: '80.00' },
    ]);
  }, /does not equal total amount/);
  console.log('  ✅ Exact split validation correctly rejects mismatches.');

  // Test 6: Database integration & Invariants
  console.log('6. Testing Database Ledger & Zero-Sum Invariant...');
  // Insert test users
  db.prepare('INSERT OR REPLACE INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)').run(901, 'Alice', 'alice_test@example.com', 'hash');
  db.prepare('INSERT OR REPLACE INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)').run(902, 'Bob', 'bob_test@example.com', 'hash');
  db.prepare('INSERT OR REPLACE INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)').run(903, 'Charlie', 'charlie_test@example.com', 'hash');

  // Insert group
  db.prepare('INSERT OR REPLACE INTO groups (id, name, type, created_by) VALUES (?, ?, ?, ?)').run(999, 'Test Roommates', 'roommates', 901);
  db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(999, 901);
  db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(999, 902);
  db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(999, 903);

  // Alice pays ₹300 for groceries shared by Alice, Bob, Charlie (Equal)
  const expTx = recordExpense({
    groupId: 999,
    description: 'Groceries',
    amount: '300.00',
    splitType: 'EQUAL',
    paidByUserId: 901,
    participants: [901, 902, 903],
    createdByUserId: 901,
  });

  // Verify transaction ledger entries sum to zero
  const sumTx = db.prepare('SELECT SUM(amount_paise) as sum FROM ledger_entries WHERE transaction_id = ?').get(expTx.id);
  assert.strictEqual(sumTx.sum, 0, 'Transaction entries must sum to zero');
  console.log('  ✅ Transaction entries sum strictly to 0.');

  // Check balances
  const balances = getGroupBalances(999);
  const alice = balances.find(b => b.userId === 901);
  const bob = balances.find(b => b.userId === 902);
  const charlie = balances.find(b => b.userId === 903);

  // Alice paid 300, consumed 100 -> net +200
  // Bob consumed 100 -> net -100
  // Charlie consumed 100 -> net -100
  assert.strictEqual(alice.netPaise, 20000);
  assert.strictEqual(bob.netPaise, -10000);
  assert.strictEqual(charlie.netPaise, -10000);
  console.log('  ✅ Net balances verified: Alice +₹200, Bob -₹100, Charlie -₹100.');

  // Test 7: Debt Simplification (Min-Cash-Flow)
  console.log('7. Testing Min-Cash-Flow Simplification...');
  const simplified = simplifyDebts(balances);
  assert.strictEqual(simplified.length, 2, 'Should only need 2 payments to settle all 3 users');
  console.log('  Simplified payments:', simplified);
  console.log('  ✅ Debt simplification algorithm passed.');

  // Test 8: Settlement
  console.log('8. Testing Settlement...');
  // Bob pays Alice ₹100
  const settleTx = recordSettlement({
    groupId: 999,
    fromUserId: 902,
    toUserId: 901,
    amount: '100.00',
    notes: 'Bob settled grocery share',
    createdByUserId: 902,
  });
  const sumSettle = db.prepare('SELECT SUM(amount_paise) as sum FROM ledger_entries WHERE transaction_id = ?').get(settleTx.id);
  assert.strictEqual(sumSettle.sum, 0);

  const balancesAfter = getGroupBalances(999);
  const bobAfter = balancesAfter.find(b => b.userId === 902);
  assert.strictEqual(bobAfter.netPaise, 0, 'Bob is now fully settled');
  console.log('  ✅ Settlement verified: Bob is now at ₹0.00 net.');

  // Test 9: Immutable Reversal (Deleting expense)
  console.log('9. Testing Immutable Reversal...');
  const reversalTx = reverseTransaction(expTx.id, 901, 'Testing deletion');
  const sumCombined = db.prepare('SELECT SUM(amount_paise) as sum FROM ledger_entries WHERE transaction_id IN (?, ?)').get(expTx.id, reversalTx.id);
  assert.strictEqual(sumCombined.sum, 0, 'Original + Reversal ledger entries sum strictly to 0');
  console.log('  ✅ Immutable reversal verified.');

  // Clean up test data
  db.prepare('DELETE FROM ledger_entries WHERE group_id = 999').run();
  db.prepare('DELETE FROM transactions WHERE group_id = 999').run();
  db.prepare('DELETE FROM activity_logs WHERE group_id = 999').run();
  db.prepare('DELETE FROM group_members WHERE group_id = 999').run();
  db.prepare('DELETE FROM groups WHERE id = 999').run();
  db.prepare('DELETE FROM users WHERE id IN (901, 902, 903)').run();

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! Core ledger integrity confirmed.\n');
}

runTests();
