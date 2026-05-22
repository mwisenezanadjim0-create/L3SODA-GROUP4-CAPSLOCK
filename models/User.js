/**
 * User Model for SQLite
 * 
 * This model provides a Mongoose-like interface for working with users
 * in the SQLite database used by the Dodos Car Limited server.
 * 
 * Usage:
 *   const User = require('./models/User');
 *   
 *   // Create a new user
 *   const user = await User.create({ username, email, password });
 *   
 *   // Find user by email
 *   const user = await User.findByEmail('user@example.com');
 *   
 *   // Verify email
 *   const verifiedUser = await User.verifyEmail(token);
 */

class UserModel {
  constructor(db) {
    this.db = db;
  }

  /**
   * Initialize the database with the users table
   */
  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        email_verified INTEGER DEFAULT 0,
        email_verification_token TEXT,
        email_verification_expires INTEGER,
        role TEXT DEFAULT 'user',
        failed_login_attempts INTEGER DEFAULT 0,
        locked_until INTEGER,
        last_login INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
  }

  /**
   * Create a new user
   * @param {Object} data - User data { username, email, password }
   * @returns {Object} Created user
   */
  create(data) {
    const crypto = require('crypto');
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    const emailVerificationExpires = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
    
    // Hash password using PBKDF2
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(data.password, salt, 210000, 32, 'sha256').toString('hex');
    const passwordHash = `${salt}:${hash}`;
    
    const result = this.db.prepare(`
      INSERT INTO users (username, email, password_hash, email_verification_token, email_verification_expires)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.username, data.email, passwordHash, emailVerificationToken, emailVerificationExpires);
    
    return {
      id: result.lastInsertRowid,
      username: data.username,
      email: data.email,
      emailVerified: false,
      emailVerificationToken,
      role: 'user',
      createdAt: new Date().toISOString()
    };
  }

  /**
   * Find user by email
   * @param {string} email - User email
   * @returns {Object|null} User or null
   */
  findByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }

  /**
   * Find user by username
   * @param {string} username - Username
   * @returns {Object|null} User or null
   */
  findByUsername(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  /**
   * Find user by username or email
   * @param {string} query - Username or email
   * @returns {Object|null} User or null
   */
  findByUsernameOrEmail(query) {
    return this.db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(query, query);
  }

  /**
   * Find user by ID
   * @param {number} id - User ID
   * @returns {Object|null} User or null
   */
  findById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  /**
   * Find user by email verification token
   * @param {string} token - Verification token
   * @returns {Object|null} User or null
   */
  findByVerificationToken(token) {
    return this.db.prepare('SELECT * FROM users WHERE email_verification_token = ? AND email_verification_expires > ?').get(token, Date.now());
  }

  /**
   * Verify user's email
   * @param {string} token - Verification token
   * @returns {Object|null} Verified user or null
   */
  verifyEmail(token) {
    const user = this.findByVerificationToken(token);
    if (!user) return null;
    
    this.db.prepare('UPDATE users SET email_verified = 1, email_verification_token = NULL, email_verification_expires = NULL WHERE id = ?').run(user.id);
    return this.findById(user.id);
  }

  /**
   * Record user login
   * @param {number} id - User ID
   */
  recordLogin(id) {
    this.db.prepare('UPDATE users SET last_login = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(Date.now(), id);
  }

  /**
   * Increment failed login attempts
   * @param {number} id - User ID
   * @returns {number} Number of failed attempts
   */
  incrementFailedLogin(id) {
    const user = this.findById(id);
    const attempts = (user.failed_login_attempts || 0) + 1;
    const lockedUntil = attempts >= 5 ? Date.now() + (15 * 60 * 1000) : null; // 15 min lockout after 5 attempts
    
    this.db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?').run(attempts, lockedUntil, id);
    return attempts;
  }

  /**
   * Check if account is locked
   * @param {number} id - User ID
   * @returns {boolean} True if locked
   */
  isLocked(id) {
    const user = this.findById(id);
    if (!user || !user.locked_until) return false;
    return Date.now() < user.locked_until;
  }

  /**
   * List all users
   * @returns {Array} Array of users
   */
  listAll() {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  }

  /**
   * Count total users
   * @returns {number} Total count
   */
  count() {
    return this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  }

  /**
   * Update user role
   * @param {number} id - User ID
   * @param {string} role - New role
   * @returns {Object|null} Updated user
   */
  updateRole(id, role) {
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    return this.findById(id);
  }

  /**
   * Update user email verification status
   * @param {number} id - User ID
   * @param {boolean} verified - Verification status
   */
  updateEmailVerified(id, verified) {
    this.db.prepare('UPDATE users SET email_verified = ? WHERE id = ?').run(verified ? 1 : 0, id);
  }

  /**
   * Delete user by ID
   * @param {number} id - User ID
   * @returns {boolean} Success
   */
  deleteById(id) {
    const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * Search users by username or email
   * @param {string} query - Search query
   * @returns {Array} Matching users
   */
  search(query) {
    const searchTerm = `%${query}%`;
    return this.db.prepare('SELECT * FROM users WHERE username LIKE ? OR email LIKE ? ORDER BY created_at DESC').all(searchTerm, searchTerm);
  }

  /**
   * Get user statistics
   * @returns {Object} Statistics
   */
  getStats() {
    const total = this.count();
    const verified = this.db.prepare('SELECT COUNT(*) AS count FROM users WHERE email_verified = 1').get().count;
    const locked = this.db.prepare('SELECT COUNT(*) AS count FROM users WHERE locked_until > ?').get(Date.now()).count;
    const activeToday = this.db.prepare('SELECT COUNT(*) AS count FROM users WHERE last_login > ?').get(Date.now() - (24 * 60 * 60 * 1000)).count;
    
    return {
      total,
      verified,
      unverified: total - verified,
      locked,
      activeToday
    };
  }
}

// Export a factory function that creates a UserModel instance with a database
module.exports = (db) => {
  const model = new UserModel(db);
  model.init();
  return model;
};

// Also export the class for advanced use cases
module.exports.UserModel = UserModel;