const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const idempotencyMiddleware = require('../middleware/idempotency');
const { recordSettlement } = require('../ledger');

// Record settlement (full or partial)
// Supports Idempotency-Key header to prevent duplicate payments
router.post('/', authenticateToken, idempotencyMiddleware, (req, res) => {
  const { groupId, fromUserId, toUserId, amount, notes } = req.body;

  if (!fromUserId || !toUserId || amount === undefined) {
    return res.status(400).json({ error: 'fromUserId, toUserId, and amount are required.' });
  }

  const fUserId = parseInt(fromUserId, 10);
  const tUserId = parseInt(toUserId, 10);
  const gId = groupId ? parseInt(groupId, 10) : null;

  if (fUserId === tUserId) {
    return res.status(400).json({ error: 'Payer and payee cannot be the same user.' });
  }

  // The authenticated user should either be the payer or payee or an admin/group member
  if (gId) {
    const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(gId, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this group.' });
    }
  }

  try {
    const tx = recordSettlement({
      groupId: gId,
      fromUserId: fUserId,
      toUserId: tUserId,
      amount,
      notes: notes || 'Settlement payment',
      createdByUserId: req.user.id,
    });

    return res.status(201).json({
      message: 'Settlement recorded successfully',
      transaction: tx,
    });
  } catch (err) {
    console.error('Record settlement error:', err);
    return res.status(400).json({ error: err.message || 'Failed to record settlement.' });
  }
});

module.exports = router;
