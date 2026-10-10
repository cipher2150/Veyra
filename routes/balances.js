const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { getGroupBalances, simplifyDebts, getPairwiseDebts, getUserBalanceSummary } = require('../debt_simplification');

// Balances for a specific group
router.get('/group/:id', authenticateToken, (req, res) => {
  const groupId = parseInt(req.params.id, 10);

  try {
    const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this group.' });
    }

    const summary = getUserBalanceSummary(req.user.id, groupId);
    return res.json(summary);
  } catch (err) {
    console.error('Group balances error:', err);
    return res.status(500).json({ error: 'Failed to compute group balances.' });
  }
});

// Global balances across all groups
router.get('/global', authenticateToken, (req, res) => {
  try {
    // Find all users who share at least one group with current user
    const sharedUsers = db.prepare(`
      SELECT DISTINCT gm2.user_id, u.name, u.email
      FROM group_members gm1
      JOIN group_members gm2 ON gm1.group_id = gm2.group_id
      JOIN users u ON gm2.user_id = u.id
      WHERE gm1.user_id = ?
    `).all(req.user.id);

    const sharedUserIds = sharedUsers.map(u => u.user_id);
    if (!sharedUserIds.includes(req.user.id)) {
      sharedUserIds.push(req.user.id);
    }

    // Compute net balance across all groups for these users
    const balances = sharedUsers.map(u => {
      const row = db.prepare(`
        SELECT COALESCE(SUM(amount_paise), 0) AS net_paise
        FROM ledger_entries
        WHERE user_id = ?
      `).get(u.user_id);

      const net = Number(row.net_paise);
      let status = 'SETTLED';
      if (net > 0) status = 'OWED';
      else if (net < 0) status = 'OWES';

      return {
        userId: u.user_id,
        name: u.name,
        email: u.email,
        netPaise: net,
        netRupees: (net / 100).toFixed(2),
        status,
      };
    });

    const simplified = simplifyDebts(balances);

    const currentUserBalance = balances.find(b => b.userId === req.user.id) || {
      userId: req.user.id,
      netPaise: 0,
      netRupees: '0.00',
      status: 'SETTLED',
    };

    return res.json({
      user: currentUserBalance,
      allBalances: balances,
      simplified: {
        all: simplified,
        youOwe: simplified.filter(s => s.fromUserId === req.user.id),
        owedToYou: simplified.filter(s => s.toUserId === req.user.id),
      },
    });
  } catch (err) {
    console.error('Global balances error:', err);
    return res.status(500).json({ error: 'Failed to compute global balances.' });
  }
});

module.exports = router;
