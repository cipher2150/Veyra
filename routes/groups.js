const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { toRupees } = require('../ledger');

// Create group
router.post('/', authenticateToken, (req, res) => {
  const { name, type = 'roommates' } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Group name is required.' });
  }

  const validTypes = ['roommates', 'trip', 'colleagues', 'other'];
  const groupType = validTypes.includes(type) ? type : 'other';

  try {
    const createTx = db.transaction(() => {
      // Insert group
      const result = db.prepare(`
        INSERT INTO groups (name, type, created_by)
        VALUES (?, ?, ?)
      `).run(name.trim(), groupType, req.user.id);

      const groupId = result.lastInsertRowid;

      // Automatically add creator as member
      db.prepare(`
        INSERT INTO group_members (group_id, user_id)
        VALUES (?, ?)
      `).run(groupId, req.user.id);

      // Log activity
      db.prepare(`
        INSERT INTO activity_logs (group_id, user_id, action, details)
        VALUES (?, ?, 'GROUP_CREATED', ?)
      `).run(groupId, req.user.id, JSON.stringify({ name: name.trim(), type: groupType }));

      return groupId;
    });

    const groupId = createTx();
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);

    return res.status(201).json(group);
  } catch (err) {
    console.error('Create group error:', err);
    return res.status(500).json({ error: 'Failed to create group.' });
  }
});

// List groups for current user
router.get('/', authenticateToken, (req, res) => {
  try {
    const groups = db.prepare(`
      SELECT 
        g.*,
        u.name AS created_by_name,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count,
        COALESCE((
          SELECT SUM(amount_paise) 
          FROM ledger_entries 
          WHERE group_id = g.id AND user_id = ?
        ), 0) AS user_net_paise
      FROM groups g
      JOIN group_members gm ON g.id = gm.group_id
      JOIN users u ON g.created_by = u.id
      WHERE gm.user_id = ?
      ORDER BY g.created_at DESC
    `).all(req.user.id, req.user.id);

    const formatted = groups.map(g => ({
      ...g,
      user_net_rupees: toRupees(g.user_net_paise),
    }));

    return res.json(formatted);
  } catch (err) {
    console.error('List groups error:', err);
    return res.status(500).json({ error: 'Failed to retrieve groups.' });
  }
});

// Get group details & members
router.get('/:id', authenticateToken, (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  try {
    const group = db.prepare(`
      SELECT g.*, u.name AS created_by_name
      FROM groups g
      JOIN users u ON g.created_by = u.id
      WHERE g.id = ?
    `).get(groupId);

    if (!group) {
      return res.status(404).json({ error: 'Group not found.' });
    }

    // Verify current user is a member
    const isMember = db.prepare(`
      SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?
    `).get(groupId, req.user.id);

    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this group.' });
    }

    const members = db.prepare(`
      SELECT 
        u.id, 
        u.name, 
        u.email, 
        gm.joined_at,
        COALESCE((
          SELECT SUM(amount_paise)
          FROM ledger_entries
          WHERE group_id = ? AND user_id = u.id
        ), 0) AS net_paise
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      WHERE gm.group_id = ?
      ORDER BY u.name ASC
    `).all(groupId, groupId);

    const formattedMembers = members.map(m => ({
      ...m,
      net_rupees: toRupees(m.net_paise),
    }));

    return res.json({
      group,
      members: formattedMembers,
    });
  } catch (err) {
    console.error('Get group error:', err);
    return res.status(500).json({ error: 'Failed to retrieve group details.' });
  }
});

// Add member to group
router.post('/:id/members', authenticateToken, (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const { email, userId } = req.body;

  try {
    // Verify current user is member
    const membership = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You must be a member to invite others.' });
    }

    let targetUser = null;
    if (userId) {
      targetUser = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId);
    } else if (email) {
      targetUser = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email.trim().toLowerCase());
    }

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found. Ensure the user is registered first.' });
    }

    // Check if already in group
    const alreadyMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, targetUser.id);
    if (alreadyMember) {
      return res.status(409).json({ error: `${targetUser.name} is already a member of this group.` });
    }

    const addTx = db.transaction(() => {
      db.prepare(`
        INSERT INTO group_members (group_id, user_id)
        VALUES (?, ?)
      `).run(groupId, targetUser.id);

      db.prepare(`
        INSERT INTO activity_logs (group_id, user_id, action, details)
        VALUES (?, ?, 'MEMBER_ADDED', ?)
      `).run(groupId, req.user.id, JSON.stringify({ addedUserId: targetUser.id, addedUserName: targetUser.name }));
    });

    addTx();

    return res.status(201).json({ message: 'Member added successfully', user: targetUser });
  } catch (err) {
    console.error('Add member error:', err);
    return res.status(500).json({ error: 'Failed to add member to group.' });
  }
});

// Group activity logs
router.get('/:id/activity', authenticateToken, (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  try {
    const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const logs = db.prepare(`
      SELECT al.*, u.name AS user_name, u.email AS user_email
      FROM activity_logs al
      JOIN users u ON al.user_id = u.id
      WHERE al.group_id = ?
      ORDER BY al.id DESC
      LIMIT 100
    `).all(groupId);

    const formatted = logs.map(l => {
      let parsed = {};
      try {
        parsed = JSON.parse(l.details);
      } catch (e) {
        parsed = { text: l.details };
      }
      return {
        ...l,
        details: parsed,
      };
    });

    return res.json(formatted);
  } catch (err) {
    console.error('Get activity error:', err);
    return res.status(500).json({ error: 'Failed to fetch activity logs.' });
  }
});

module.exports = router;
