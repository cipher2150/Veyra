const db = require('./db');
const { toRupees } = require('./ledger');

/**
 * Computes net balances for all members of a group (or globally if groupId is null).
 * Returns array of { userId, name, email, netPaise, netRupees, status: 'OWED' | 'OWES' | 'SETTLED' }
 */
function getGroupBalances(groupId = null) {
  let query = '';
  let params = [];

  if (groupId) {
    query = `
      SELECT 
        u.id AS user_id, 
        u.name AS user_name, 
        u.email AS user_email,
        COALESCE(SUM(le.amount_paise), 0) AS net_paise
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      LEFT JOIN ledger_entries le ON le.user_id = u.id AND le.group_id = gm.group_id
      WHERE gm.group_id = ?
      GROUP BY u.id
      ORDER BY u.name ASC
    `;
    params = [groupId];
  } else {
    // Global across all groups
    query = `
      SELECT 
        u.id AS user_id, 
        u.name AS user_name, 
        u.email AS user_email,
        COALESCE(SUM(le.amount_paise), 0) AS net_paise
      FROM users u
      LEFT JOIN ledger_entries le ON le.user_id = u.id
      GROUP BY u.id
      ORDER BY u.name ASC
    `;
    params = [];
  }

  const rows = db.prepare(query).all(...params);

  return rows.map(r => {
    const net = Number(r.net_paise);
    let status = 'SETTLED';
    if (net > 0) status = 'OWED'; // Creditor: others owe this user
    else if (net < 0) status = 'OWES'; // Debtor: this user owes others

    return {
      userId: r.user_id,
      name: r.user_name,
      email: r.user_email,
      netPaise: net,
      netRupees: toRupees(net),
      status,
    };
  });
}

/**
 * Min-Cash-Flow Debt Simplification Algorithm.
 * Given net balances, finds the minimum number of transactions needed to settle all debts.
 * @param {Array} balances - Output from getGroupBalances()
 * @returns {Array} List of simplified transactions { fromUser, toUser, amountPaise, amountRupees }
 */
function simplifyDebts(balances) {
  // Separate into debtors (net < 0) and creditors (net > 0)
  // Deep clone so we can mutate amounts
  const debtors = [];
  const creditors = [];

  for (const b of balances) {
    if (b.netPaise < 0) {
      debtors.push({
        userId: b.userId,
        name: b.name,
        amount: Math.abs(b.netPaise),
      });
    } else if (b.netPaise > 0) {
      creditors.push({
        userId: b.userId,
        name: b.name,
        amount: b.netPaise,
      });
    }
  }

  // Sort descending by amount for greedy min-cash-flow
  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const simplifiedPayments = [];
  let dIdx = 0;
  let cIdx = 0;

  while (dIdx < debtors.length && cIdx < creditors.length) {
    const debtor = debtors[dIdx];
    const creditor = creditors[cIdx];

    const settlePaise = Math.min(debtor.amount, creditor.amount);

    if (settlePaise > 0) {
      simplifiedPayments.push({
        fromUserId: debtor.userId,
        fromUserName: debtor.name,
        toUserId: creditor.userId,
        toUserName: creditor.name,
        amountPaise: settlePaise,
        amountRupees: toRupees(settlePaise),
      });

      debtor.amount -= settlePaise;
      creditor.amount -= settlePaise;
    }

    if (debtor.amount === 0) dIdx++;
    if (creditor.amount === 0) cIdx++;
  }

  return simplifiedPayments;
}

/**
 * Computes pairwise detailed breakdown (Direct debts) between members of a group:
 * For each pair of users (A, B), calculates net amount A owes B or B owes A
 * based on expense splits where one paid and the other participated, minus settlements.
 */
function getPairwiseDebts(groupId) {
  // Fetch all non-reversed transactions for the group
  const txs = db.prepare(`
    SELECT t.id, t.type, t.amount_paise, t.created_by
    FROM transactions t
    WHERE t.group_id = ? AND t.is_reversed = 0
    ORDER BY t.id ASC
  `).all(groupId);

  // Map of pairwise net debt: pairKey "minId-maxId" -> balance where positive means minId owes maxId
  // Or direct directed graph: netMap[payer][consumer]
  const pairMatrix = {}; // from -> to -> paise

  function addDebt(fromUser, toUser, paise) {
    if (fromUser === toUser || paise === 0) return;
    if (!pairMatrix[fromUser]) pairMatrix[fromUser] = {};
    pairMatrix[fromUser][toUser] = (pairMatrix[fromUser][toUser] || 0) + paise;
  }

  for (const tx of txs) {
    const entries = db.prepare(`
      SELECT user_id, amount_paise, entry_type
      FROM ledger_entries
      WHERE transaction_id = ?
    `).all(tx.id);

    if (tx.type === 'EXPENSE') {
      const payerEntry = entries.find(e => e.entry_type === 'PAYER_CREDIT');
      if (!payerEntry) continue;
      const payerId = payerEntry.user_id;

      for (const entry of entries) {
        if (entry.entry_type === 'EXPENSE_SHARE_DEBIT') {
          const participantId = entry.user_id;
          const sharePaise = Math.abs(entry.amount_paise);
          // participant owes payer
          addDebt(participantId, payerId, sharePaise);
        }
      }
    } else if (tx.type === 'SETTLEMENT') {
      const paymentEntry = entries.find(e => e.entry_type === 'SETTLEMENT_PAYMENT');
      const receiptEntry = entries.find(e => e.entry_type === 'SETTLEMENT_RECEIPT');
      if (paymentEntry && receiptEntry) {
        // Debtor paid settlement to creditor -> reduces debt of paymentEntry.user_id to receiptEntry.user_id
        // which is equivalent to adding reverse flow
        addDebt(receiptEntry.user_id, paymentEntry.user_id, Math.abs(receiptEntry.amount_paise));
      }
    }
  }

  // Net out pairwise directions: if A owes B 100 and B owes A 40, A owes B 60 net.
  const users = db.prepare(`
    SELECT u.id, u.name FROM group_members gm JOIN users u ON gm.user_id = u.id WHERE gm.group_id = ?
  `).all(groupId);
  const userMap = new Map(users.map(u => [u.id, u.name]));

  const directPairs = [];
  const processed = new Set();

  for (const u1 of users) {
    for (const u2 of users) {
      if (u1.id >= u2.id) continue;
      const id1 = u1.id;
      const id2 = u2.id;
      const key = `${id1}-${id2}`;
      if (processed.has(key)) continue;
      processed.add(key);

      const owes1to2 = (pairMatrix[id1] && pairMatrix[id1][id2]) || 0;
      const owes2to1 = (pairMatrix[id2] && pairMatrix[id2][id1]) || 0;

      const net = owes1to2 - owes2to1;
      if (net > 0) {
        // id1 owes id2
        directPairs.push({
          fromUserId: id1,
          fromUserName: userMap.get(id1),
          toUserId: id2,
          toUserName: userMap.get(id2),
          amountPaise: net,
          amountRupees: toRupees(net),
        });
      } else if (net < 0) {
        // id2 owes id1
        directPairs.push({
          fromUserId: id2,
          fromUserName: userMap.get(id2),
          toUserId: id1,
          toUserName: userMap.get(id1),
          amountPaise: Math.abs(net),
          amountRupees: toRupees(Math.abs(net)),
        });
      }
    }
  }

  return directPairs;
}

/**
 * Returns complete balance summary for a user:
 * - Net balance in group (or across all groups)
 * - Who the user owes, and who owes the user
 * - Simplified settlement plan
 */
function getUserBalanceSummary(userId, groupId = null) {
  const balances = getGroupBalances(groupId);
  const simplified = simplifyDebts(balances);
  const direct = groupId ? getPairwiseDebts(groupId) : [];

  const userBalance = balances.find(b => b.userId === userId) || {
    userId,
    netPaise: 0,
    netRupees: '0.00',
    status: 'SETTLED',
  };

  // Debts involving this specific user
  const simplifiedYouOwe = simplified.filter(s => s.fromUserId === userId);
  const simplifiedOwedToYou = simplified.filter(s => s.toUserId === userId);

  const directYouOwe = direct.filter(d => d.fromUserId === userId);
  const directOwedToYou = direct.filter(d => d.toUserId === userId);

  return {
    user: userBalance,
    allBalances: balances,
    simplified: {
      all: simplified,
      youOwe: simplifiedYouOwe,
      owedToYou: simplifiedOwedToYou,
    },
    direct: {
      all: direct,
      youOwe: directYouOwe,
      owedToYou: directOwedToYou,
    },
  };
}

module.exports = {
  getGroupBalances,
  simplifyDebts,
  getPairwiseDebts,
  getUserBalanceSummary,
};
