const db = require('./db');

/**
 * Converts decimal rupee input (e.g. 100.50 or "100.50") to integer paise (10050).
 */
function toPaise(amount) {
  if (typeof amount === 'number') {
    return Math.round(amount * 100);
  }
  if (typeof amount === 'string') {
    const parsed = parseFloat(amount.trim());
    if (isNaN(parsed)) {
      throw new Error(`Invalid amount string: ${amount}`);
    }
    return Math.round(parsed * 100);
  }
  throw new Error(`Invalid amount type: ${typeof amount}`);
}

/**
 * Converts integer paise to rupee string formatted to 2 decimal places.
 */
function toRupees(paise) {
  return (paise / 100).toFixed(2);
}

/**
 * Calculates exact paise shares for participants based on split type.
 * Ensures that sum(shares) === totalPaise with ZERO paise lost or created.
 */
function calculateSplits(totalPaise, splitType, participants) {
  if (!participants || participants.length === 0) {
    throw new Error('At least one participant is required for an expense.');
  }

  const n = participants.length;
  const sharesMap = {};

  if (totalPaise <= 0) {
    throw new Error('Expense amount must be greater than zero.');
  }

  switch (splitType) {
    case 'EQUAL': {
      const baseShare = Math.floor(totalPaise / n);
      const remainder = totalPaise % n;

      participants.forEach((p, index) => {
        const userId = typeof p === 'object' ? p.userId : p;
        // Distribute remainder paise one by one to the first 'remainder' participants
        const allocated = baseShare + (index < remainder ? 1 : 0);
        sharesMap[userId] = allocated;
      });
      break;
    }

    case 'EXACT': {
      let sum = 0;
      for (const p of participants) {
        if (!p.userId || p.amount === undefined) {
          throw new Error('Each participant must have userId and amount for EXACT split.');
        }
        const userPaise = toPaise(p.amount);
        if (userPaise < 0) {
          throw new Error('Participant amount cannot be negative.');
        }
        sharesMap[p.userId] = userPaise;
        sum += userPaise;
      }

      if (sum !== totalPaise) {
        const diffRupees = toRupees(Math.abs(sum - totalPaise));
        const status = sum < totalPaise ? 'under by' : 'over by';
        throw new Error(`Exact shares sum (₹${toRupees(sum)}) does not equal total amount (₹${toRupees(totalPaise)}). It is ${status} ₹${diffRupees}.`);
      }
      break;
    }

    case 'PERCENTAGE': {
      let totalPct = 0;
      for (const p of participants) {
        if (!p.userId || p.percentage === undefined) {
          throw new Error('Each participant must have userId and percentage for PERCENTAGE split.');
        }
        const pct = parseFloat(p.percentage);
        if (isNaN(pct) || pct < 0) {
          throw new Error('Percentage must be a non-negative number.');
        }
        totalPct += pct;
      }

      // Check sum of percentages is approx 100% (allow tiny floating precision tolerance)
      if (Math.abs(totalPct - 100) > 0.05) {
        throw new Error(`Total percentage must sum to 100%. Current sum is ${totalPct.toFixed(2)}%.`);
      }

      // Largest remainder method (Hare-Niemeyer method)
      let allocatedSum = 0;
      const fractions = [];

      participants.forEach(p => {
        const raw = (totalPaise * parseFloat(p.percentage)) / 100;
        const floorVal = Math.floor(raw);
        const frac = raw - floorVal;
        sharesMap[p.userId] = floorVal;
        allocatedSum += floorVal;
        fractions.push({ userId: p.userId, frac });
      });

      const remainder = totalPaise - allocatedSum;
      // Sort descending by fractional part
      fractions.sort((a, b) => b.frac - a.frac);
      for (let i = 0; i < remainder; i++) {
        sharesMap[fractions[i].userId] += 1;
      }
      break;
    }

    case 'SHARES': {
      let totalShares = 0;
      for (const p of participants) {
        if (!p.userId || p.shares === undefined) {
          throw new Error('Each participant must have userId and shares for SHARES split.');
        }
        const s = parseInt(p.shares, 10);
        if (isNaN(s) || s <= 0) {
          throw new Error('Shares count must be a positive integer.');
        }
        totalShares += s;
      }

      if (totalShares <= 0) {
        throw new Error('Total shares count must be greater than zero.');
      }

      let allocatedSum = 0;
      const fractions = [];

      participants.forEach(p => {
        const s = parseInt(p.shares, 10);
        const raw = (totalPaise * s) / totalShares;
        const floorVal = Math.floor(raw);
        const frac = raw - floorVal;
        sharesMap[p.userId] = floorVal;
        allocatedSum += floorVal;
        fractions.push({ userId: p.userId, frac });
      });

      const remainder = totalPaise - allocatedSum;
      fractions.sort((a, b) => b.frac - a.frac);
      for (let i = 0; i < remainder; i++) {
        sharesMap[fractions[i].userId] += 1;
      }
      break;
    }

    default:
      throw new Error(`Unsupported split type: ${splitType}`);
  }

  // Verify paise invariant: sum(shares) === totalPaise
  const computedSum = Object.values(sharesMap).reduce((acc, curr) => acc + curr, 0);
  if (computedSum !== totalPaise) {
    throw new Error(`Paise invariant violation: allocated ${computedSum} != total ${totalPaise}`);
  }

  return sharesMap;
}

/**
 * Records an Expense in the double-entry ledger.
 * Wrapped in an atomic database transaction.
 */
function recordExpense({
  groupId,
  description,
  amount,
  splitType = 'EQUAL',
  paidByUserId,
  participants,
  createdByUserId,
}) {
  const totalPaise = toPaise(amount);
  if (totalPaise <= 0) {
    throw new Error('Expense amount must be positive.');
  }

  // Verify group membership for payer and participants
  const group = db.prepare('SELECT id, name FROM groups WHERE id = ?').get(groupId);
  if (!group) {
    throw new Error(`Group not found (id: ${groupId})`);
  }

  const memberRows = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId);
  const memberSet = new Set(memberRows.map(m => m.user_id));

  if (!memberSet.has(paidByUserId)) {
    throw new Error(`Payer (user ${paidByUserId}) is not a member of group ${groupId}`);
  }

  // Calculate exact splits
  const sharesMap = calculateSplits(totalPaise, splitType, participants);

  // Validate all participants are members of the group
  for (const userIdStr of Object.keys(sharesMap)) {
    const uid = parseInt(userIdStr, 10);
    if (!memberSet.has(uid)) {
      throw new Error(`Participant (user ${uid}) is not a member of group ${groupId}`);
    }
  }

  const executeTx = db.transaction(() => {
    // 1. Insert transaction header
    const txStmt = db.prepare(`
      INSERT INTO transactions (group_id, type, description, amount_paise, split_type, created_by)
      VALUES (?, 'EXPENSE', ?, ?, ?, ?)
    `);
    const txResult = txStmt.run(groupId, description, totalPaise, splitType, createdByUserId);
    const transactionId = txResult.lastInsertRowid;

    // 2. Insert double-entry ledger postings
    // Payer credit: +totalPaise
    const entryStmt = db.prepare(`
      INSERT INTO ledger_entries (transaction_id, group_id, user_id, amount_paise, entry_type)
      VALUES (?, ?, ?, ?, ?)
    `);

    entryStmt.run(transactionId, groupId, paidByUserId, totalPaise, 'PAYER_CREDIT');

    // Participants debit: -sharePaise
    for (const [userIdStr, sharePaise] of Object.entries(sharesMap)) {
      const uid = parseInt(userIdStr, 10);
      entryStmt.run(transactionId, groupId, uid, -sharePaise, 'EXPENSE_SHARE_DEBIT');
    }

    // 3. Invariant check: SUM(amount_paise) for this transaction === 0
    const sumRow = db.prepare(`
      SELECT SUM(amount_paise) AS net_sum FROM ledger_entries WHERE transaction_id = ?
    `).get(transactionId);

    if (sumRow.net_sum !== 0) {
      throw new Error(`Double-entry invariant failed: sum is ${sumRow.net_sum}, expected 0.`);
    }

    // 4. Log activity
    db.prepare(`
      INSERT INTO activity_logs (group_id, user_id, action, details)
      VALUES (?, ?, 'EXPENSE_CREATED', ?)
    `).run(
      groupId,
      createdByUserId,
      JSON.stringify({
        transactionId,
        description,
        amount: toRupees(totalPaise),
        paidBy: paidByUserId,
        splitType,
      })
    );

    return transactionId;
  });

  const transactionId = executeTx();
  return getTransactionDetails(transactionId);
}

/**
 * Records a Settlement between two users.
 * Debtor pays Creditor amount.
 * In ledger:
 *  - Debtor gets +amount (debt is reduced)
 *  - Creditor gets -amount (receivable is reduced)
 * Sum of entries = (+amount) + (-amount) = 0!
 */
function recordSettlement({
  groupId,
  fromUserId, // Payer (settling their debt)
  toUserId,   // Payee (receiving settlement)
  amount,
  notes = 'Settlement payment',
  createdByUserId,
}) {
  const amountPaise = toPaise(amount);
  if (amountPaise <= 0) {
    throw new Error('Settlement amount must be positive.');
  }

  if (fromUserId === toUserId) {
    throw new Error('Cannot settle with oneself.');
  }

  // Validate group membership if groupId provided
  if (groupId) {
    const memberRows = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId);
    const memberSet = new Set(memberRows.map(m => m.user_id));
    if (!memberSet.has(fromUserId)) {
      throw new Error(`Payer (user ${fromUserId}) is not a member of group ${groupId}`);
    }
    if (!memberSet.has(toUserId)) {
      throw new Error(`Payee (user ${toUserId}) is not a member of group ${groupId}`);
    }
  }

  const executeTx = db.transaction(() => {
    // 1. Transaction header
    const txResult = db.prepare(`
      INSERT INTO transactions (group_id, type, description, amount_paise, split_type, created_by)
      VALUES (?, 'SETTLEMENT', ?, ?, NULL, ?)
    `).run(groupId || null, notes, amountPaise, createdByUserId);
    const transactionId = txResult.lastInsertRowid;

    // 2. Ledger entries
    // Debtor pays out cash: their liability is cleared by +amountPaise
    db.prepare(`
      INSERT INTO ledger_entries (transaction_id, group_id, user_id, amount_paise, entry_type)
      VALUES (?, ?, ?, ?, 'SETTLEMENT_PAYMENT')
    `).run(transactionId, groupId || null, fromUserId, amountPaise);

    // Creditor receives cash: their receivable is decreased by -amountPaise
    db.prepare(`
      INSERT INTO ledger_entries (transaction_id, group_id, user_id, amount_paise, entry_type)
      VALUES (?, ?, ?, ?, 'SETTLEMENT_RECEIPT')
    `).run(transactionId, groupId || null, toUserId, -amountPaise);

    // 3. Invariant check
    const sumRow = db.prepare(`
      SELECT SUM(amount_paise) AS net_sum FROM ledger_entries WHERE transaction_id = ?
    `).get(transactionId);

    if (sumRow.net_sum !== 0) {
      throw new Error(`Double-entry invariant failed for settlement: sum is ${sumRow.net_sum}`);
    }

    // 4. Log activity
    if (groupId) {
      db.prepare(`
        INSERT INTO activity_logs (group_id, user_id, action, details)
        VALUES (?, ?, 'SETTLEMENT_RECORDED', ?)
      `).run(
        groupId,
        createdByUserId,
        JSON.stringify({
          transactionId,
          fromUserId,
          toUserId,
          amount: toRupees(amountPaise),
          notes,
        })
      );
    }

    return transactionId;
  });

  const transactionId = executeTx();
  return getTransactionDetails(transactionId);
}

/**
 * Reverses a transaction by creating an immutable REVERSAL transaction
 * with exact negated postings. Never deletes past entries!
 */
function reverseTransaction(transactionId, userId, reason = 'Transaction reversed') {
  const originalTx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
  if (!originalTx) {
    throw new Error(`Transaction ${transactionId} not found`);
  }

  if (originalTx.is_reversed) {
    throw new Error(`Transaction ${transactionId} is already reversed.`);
  }

  if (originalTx.type === 'REVERSAL') {
    throw new Error('Cannot reverse a reversal transaction.');
  }

  const originalEntries = db.prepare(`
    SELECT * FROM ledger_entries WHERE transaction_id = ?
  `).all(transactionId);

  if (originalEntries.length === 0) {
    throw new Error(`No ledger entries found for transaction ${transactionId}`);
  }

  const executeTx = db.transaction(() => {
    // 1. Mark original as reversed
    db.prepare('UPDATE transactions SET is_reversed = 1 WHERE id = ?').run(transactionId);

    // 2. Create REVERSAL transaction record
    const reversalTx = db.prepare(`
      INSERT INTO transactions (group_id, type, description, amount_paise, split_type, created_by, reversal_of_id)
      VALUES (?, 'REVERSAL', ?, ?, ?, ?, ?)
    `).run(
      originalTx.group_id,
      `Reversal: ${originalTx.description} (${reason})`,
      originalTx.amount_paise,
      originalTx.split_type,
      userId,
      transactionId
    );
    const reversalTxId = reversalTx.lastInsertRowid;

    // 3. Insert negated ledger entries
    const insertEntry = db.prepare(`
      INSERT INTO ledger_entries (transaction_id, group_id, user_id, amount_paise, entry_type)
      VALUES (?, ?, ?, ?, 'REVERSAL_ENTRY')
    `);

    for (const entry of originalEntries) {
      insertEntry.run(
        reversalTxId,
        entry.group_id,
        entry.user_id,
        -entry.amount_paise // Negate the exact amount
      );
    }

    // 4. Invariant check for reversal transaction
    const sumRow = db.prepare(`
      SELECT SUM(amount_paise) AS net_sum FROM ledger_entries WHERE transaction_id = ?
    `).get(reversalTxId);

    if (sumRow.net_sum !== 0) {
      throw new Error(`Double-entry invariant failed for reversal: sum is ${sumRow.net_sum}`);
    }

    // 5. Check cumulative sum of original + reversal entries is 0
    const combinedSum = db.prepare(`
      SELECT SUM(amount_paise) AS net_sum FROM ledger_entries 
      WHERE transaction_id IN (?, ?)
    `).get(transactionId, reversalTxId);

    if (combinedSum.net_sum !== 0) {
      throw new Error(`Net effect of original + reversal is not 0 (got ${combinedSum.net_sum})`);
    }

    // 6. Log activity
    if (originalTx.group_id) {
      db.prepare(`
        INSERT INTO activity_logs (group_id, user_id, action, details)
        VALUES (?, ?, 'EXPENSE_DELETED', ?)
      `).run(
        originalTx.group_id,
        userId,
        JSON.stringify({
          originalTransactionId: transactionId,
          reversalTransactionId: reversalTxId,
          reason,
        })
      );
    }

    return reversalTxId;
  });

  const reversalId = executeTx();
  return getTransactionDetails(reversalId);
}

/**
 * Edits an expense:
 * Immutably reverses the previous transaction, then records the new updated expense.
 */
function editExpense(transactionId, userId, newExpenseData) {
  const originalTx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
  if (!originalTx) {
    throw new Error(`Transaction ${transactionId} not found`);
  }
  if (originalTx.type !== 'EXPENSE') {
    throw new Error('Only expense transactions can be edited.');
  }
  if (originalTx.is_reversed) {
    throw new Error('Cannot edit an already reversed expense.');
  }

  const executeTx = db.transaction(() => {
    // 1. Reverse the existing transaction
    reverseTransaction(transactionId, userId, 'Replaced by edited expense');

    // 2. Record new updated expense
    const newTx = recordExpense({
      groupId: newExpenseData.groupId || originalTx.group_id,
      description: newExpenseData.description,
      amount: newExpenseData.amount,
      splitType: newExpenseData.splitType || 'EQUAL',
      paidByUserId: newExpenseData.paidByUserId,
      participants: newExpenseData.participants,
      createdByUserId: userId,
    });

    // 3. Log edit activity
    db.prepare(`
      INSERT INTO activity_logs (group_id, user_id, action, details)
      VALUES (?, ?, 'EXPENSE_UPDATED', ?)
    `).run(
      originalTx.group_id,
      userId,
      JSON.stringify({
        oldTransactionId: transactionId,
        newTransactionId: newTx.id,
        description: newExpenseData.description,
      })
    );

    return newTx;
  });

  return executeTx();
}

/**
 * Fetches transaction details along with all ledger entries and user info.
 */
function getTransactionDetails(transactionId) {
  const tx = db.prepare(`
    SELECT t.*, u.name AS created_by_name, g.name AS group_name
    FROM transactions t
    LEFT JOIN users u ON t.created_by = u.id
    LEFT JOIN groups g ON t.group_id = g.id
    WHERE t.id = ?
  `).get(transactionId);

  if (!tx) return null;

  const entries = db.prepare(`
    SELECT le.*, u.name AS user_name, u.email AS user_email
    FROM ledger_entries le
    JOIN users u ON le.user_id = u.id
    WHERE le.transaction_id = ?
    ORDER BY le.id ASC
  `).all(transactionId);

  return {
    ...tx,
    amount_rupees: toRupees(tx.amount_paise),
    entries: entries.map(e => ({
      ...e,
      amount_rupees: toRupees(e.amount_paise),
    })),
  };
}

module.exports = {
  toPaise,
  toRupees,
  calculateSplits,
  recordExpense,
  recordSettlement,
  reverseTransaction,
  editExpense,
  getTransactionDetails,
};
