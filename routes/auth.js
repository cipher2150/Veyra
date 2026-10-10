const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { generateToken, authenticateToken } = require('../middleware/auth');

// Register
router.post('/register', (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name.trim();

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  try {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
    if (existing) {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }

    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);

    const stmt = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)');
    const result = stmt.run(cleanName, cleanEmail, passwordHash);

    const user = {
      id: result.lastInsertRowid,
      name: cleanName,
      email: cleanEmail,
    };

    const token = generateToken(user);
    return res.status(201).json({ user, token });
  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({ error: 'Internal server error during registration.' });
  }
});

// Login
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const cleanEmail = email.trim().toLowerCase();

  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const validPassword = bcrypt.compareSync(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const userData = {
      id: user.id,
      name: user.name,
      email: user.email,
    };

    const token = generateToken(userData);
    return res.json({ user: userData, token });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error during login.' });
  }
});

// Current User Profile
router.get('/me', authenticateToken, (req, res) => {
  try {
    const user = db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?').get(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Global net balance in paise
    const balanceRow = db.prepare(`
      SELECT COALESCE(SUM(amount_paise), 0) AS global_paise
      FROM ledger_entries
      WHERE user_id = ?
    `).get(req.user.id);

    return res.json({
      ...user,
      global_paise: balanceRow.global_paise,
      global_rupees: (balanceRow.global_paise / 100).toFixed(2),
    });
  } catch (err) {
    console.error('Get profile error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// Search / List Users (for adding to groups)
router.get('/users', authenticateToken, (req, res) => {
  const search = req.query.search ? `%${req.query.search.trim().toLowerCase()}%` : '%';
  try {
    const users = db.prepare(`
      SELECT id, name, email FROM users
      WHERE (LOWER(name) LIKE ? OR LOWER(email) LIKE ?)
      LIMIT 20
    `).all(search, search);

    return res.json(users);
  } catch (err) {
    console.error('User search error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
