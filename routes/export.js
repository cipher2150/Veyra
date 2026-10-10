const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { toRupees } = require('../ledger');

function escapeCsvField(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

router.get('/csv', authenticateToken, (req, res) => {
  const { groupId } = req.query;

  try {
    const userGroups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(req.user.id);
    const userGroupIds = userGroups.map(g => g.group_id);

    let whereClauses = [];
    let params = [];

    if (groupId) {
      const gId = parseInt(groupId, 10);
      if (!userGroupIds.includes(gId)) {
        return res.status(403).json({ error: 'Access denied.' });
      }
      whereClauses.push('t.group_id = ?');
      params.push(gId);
    } else {
      if (userGroupIds.length === 0) {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="split_ledger_export.csv"');
        return res.send('Date,Transaction ID,Type,Group,Description,Created By,Total Amount (INR),Your Impact (INR),Status\n');
      }
      const placeholders = userGroupIds.map(() => '?').join(',');
      whereClauses.push(`(t.group_id IN (${placeholders}) OR t.id IN (SELECT transaction_id FROM ledger_entries WHERE user_id = ?))`);
      params.push(...userGroupIds, req.user.id);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

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
    `).all(req.user.id, ...params);

    const headers = [
      'Date',
      'Transaction ID',
      'Type',
      'Group',
      'Description',
      'Created By',
      'Split Type',
      'Total Amount (INR)',
      'Your Net Impact (INR)',
      'Status',
    ];

    const rows = [headers.join(',')];

    for (const t of txs) {
      const userNetPaise = t.user_net_paise !== null ? Number(t.user_net_paise) : 0;
      let status = 'Active';
      if (t.is_reversed) status = 'Reversed';
      else if (t.type === 'REVERSAL') status = 'Reversal Entry';

      const row = [
        escapeCsvField(t.created_at),
        escapeCsvField(t.id),
        escapeCsvField(t.type),
        escapeCsvField(t.group_name || 'Global'),
        escapeCsvField(t.description),
        escapeCsvField(t.created_by_name),
        escapeCsvField(t.split_type || 'N/A'),
        escapeCsvField(toRupees(t.amount_paise)),
        escapeCsvField(toRupees(userNetPaise)),
        escapeCsvField(status),
      ];

      rows.push(row.join(','));
    }

    const csvContent = rows.join('\r\n');
    const filename = groupId ? `split_ledger_group_${groupId}.csv` : 'split_ledger_all.csv';

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csvContent);
  } catch (err) {
    console.error('Export CSV error:', err);
    return res.status(500).json({ error: 'Failed to export CSV.' });
  }
});

module.exports = router;
