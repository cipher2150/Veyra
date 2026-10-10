const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { recordExpense, editExpense, reverseTransaction, getTransactionDetails } = require('../ledger');

// Create expense
router.post('/', authenticateToken, (req, res) => {
  const { groupId, description, amount, splitType = 'EQUAL', paidByUserId, participants } = req.body;

  if (!groupId || !description || amount === undefined || !paidByUserId || !participants) {
    return res.status(400).json({ error: 'groupId, description, amount, paidByUserId, and participants are required.' });
  }

  try {
    const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this group.' });
    }

    const transaction = recordExpense({
      groupId: parseInt(groupId, 10),
      description: description.trim(),
      amount,
      splitType,
      paidByUserId: parseInt(paidByUserId, 10),
      participants,
      createdByUserId: req.user.id,
    });

    return res.status(201).json(transaction);
  } catch (err) {
    console.error('Create expense error:', err);
    return res.status(400).json({ error: err.message || 'Failed to create expense.' });
  }
});

// Get expense details (including ledger entries)
router.get('/:id', authenticateToken, (req, res) => {
  const txId = parseInt(req.params.id, 10);
  try {
    const tx = getTransactionDetails(txId);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    // Verify user has access to this group
    if (tx.group_id) {
      const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(tx.group_id, req.user.id);
      if (!isMember) {
        return res.status(403).json({ error: 'Access denied.' });
      }
    }

    return res.json(tx);
  } catch (err) {
    console.error('Get expense details error:', err);
    return res.status(500).json({ error: 'Failed to retrieve transaction details.' });
  }
});

// Edit expense (Reverses old transaction, creates new transaction)
router.put('/:id', authenticateToken, (req, res) => {
  const txId = parseInt(req.params.id, 10);
  const { description, amount, splitType, paidByUserId, participants, groupId } = req.body;

  try {
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    if (tx.group_id) {
      const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(tx.group_id, req.user.id);
      if (!isMember) {
        return res.status(403).json({ error: 'Access denied.' });
      }
    }

    const updatedTx = editExpense(txId, req.user.id, {
      groupId: groupId || tx.group_id,
      description: description ? description.trim() : tx.description,
      amount: amount !== undefined ? amount : (tx.amount_paise / 100),
      splitType: splitType || tx.split_type,
      paidByUserId: paidByUserId ? parseInt(paidByUserId, 10) : req.user.id,
      participants: participants,
    });

    return res.json(updatedTx);
  } catch (err) {
    console.error('Edit expense error:', err);
    return res.status(400).json({ error: err.message || 'Failed to edit expense.' });
  }
});

// Delete expense (Creates immutable reversing transaction)
router.delete('/:id', authenticateToken, (req, res) => {
  const txId = parseInt(req.params.id, 10);
  const { reason = 'Expense deleted by user' } = req.body || {};

  try {
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    if (tx.group_id) {
      const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(tx.group_id, req.user.id);
      if (!isMember) {
        return res.status(403).json({ error: 'Access denied.' });
      }
    }

    const reversalTx = reverseTransaction(txId, req.user.id, reason);
    return res.json({
      message: 'Expense successfully reversed and deleted from active balance.',
      reversalTransaction: reversalTx,
    });
  } catch (err) {
    console.error('Delete/Reverse expense error:', err);
    return res.status(400).json({ error: err.message || 'Failed to reverse expense.' });
  }
});

module.exports = router;
