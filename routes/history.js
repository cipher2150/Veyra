const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { toRupees } = require('../ledger');

// Paginated, filterable transaction history
router.get('/', authenticateToken, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 15));
  const offset = (page - 1) * limit;

  const { groupId, type, search, startDate, endDate } = req.query;

  try {
    // Determine groups user is a member of
    const userGroups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(req.user.id);
    const userGroupIds = userGroups.map(g => g.group_id);

    if (userGroupIds.length === 0) {
      return res.json({
        transactions: [],
        pagination: { page, limit, totalCount: 0, totalPages: 0 },
      });
    }

    let whereClauses = [];
    let params = [];

    // Filter by group or restrict to user's groups
    if (groupId) {
      const gId = parseInt(groupId, 10);
      if (!userGroupIds.includes(gId)) {
        return res.status(403).json({ error: 'Access denied to this group.' });
      }
      whereClauses.push('t.group_id = ?');
      params.push(gId);
    } else {
      // In user's groups OR cross-group transaction involving user
      const placeholders = userGroupIds.map(() => '?').join(',');
      whereClauses.push(`(t.group_id IN (${placeholders}) OR t.id IN (SELECT transaction_id FROM ledger_entries WHERE user_id = ?))`);
      params.push(...userGroupIds, req.user.id);
    }

    if (type) {
      whereClauses.push('t.type = ?');
      params.push(type.toUpperCase());
    }

    if (search && search.trim()) {
      whereClauses.push('(t.description LIKE ?)');
      params.push(`%${search.trim()}%`);
    }

    if (startDate) {
      whereClauses.push('date(t.created_at) >= date(?)');
      params.push(startDate);
    }

    if (endDate) {
      whereClauses.push('date(t.created_at) <= date(?)');
      params.push(endDate);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Total count
    const countRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM transactions t
      ${whereSql}
    `).get(...params);

    const totalCount = countRow.total;
    const totalPages = Math.ceil(totalCount / limit);

    // Fetch paginated transactions
    const txs = db.prepare(`
      SELECT 
        t.*,
        u.name AS created_by_name,
        g.name AS group_name,
        (
          SELECT SUM(amount_paise) 
          FROM ledger_entries 
          WHERE transaction_id = t.id AND user_id = ?
        ) AS user_net_paise
      FROM transactions t
      LEFT JOIN users u ON t.created_by = u.id
      LEFT JOIN groups g ON t.group_id = g.id
      ${whereSql}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ? OFFSET ?
    `).all(req.user.id, ...params, limit, offset);

    // Format transaction items
    const formatted = txs.map(t => {
      const userNetPaise = t.user_net_paise !== null ? Number(t.user_net_paise) : 0;
      return {
        id: t.id,
        groupId: t.group_id,
        groupName: t.group_name || 'Individual / Global',
        type: t.type,
        description: t.description,
        amountPaise: t.amount_paise,
        amountRupees: toRupees(t.amount_paise),
        splitType: t.split_type,
        createdBy: {
          id: t.created_by,
          name: t.created_by_name,
        },
        isReversed: Boolean(t.is_reversed),
        reversalOfId: t.reversal_of_id,
        createdAt: t.created_at,
        userNetPaise,
        userNetRupees: toRupees(userNetPaise),
      };
    });

    return res.json({
      transactions: formatted,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
      },
    });
  } catch (err) {
    console.error('History fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch transaction history.' });
  }
});

module.exports = router;
