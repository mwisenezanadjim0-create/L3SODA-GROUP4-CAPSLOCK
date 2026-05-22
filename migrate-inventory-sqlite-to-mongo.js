const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { MongoClient } = require('mongodb');

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.env'));

const SQLITE_PATH = process.env.SQLITE_INVENTORY_PATH || findSqliteInventory();
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const MONGODB_DB = process.env.MONGODB_DB || 'dodos_inventory';

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function findSqliteInventory() {
  const primary = path.join(ROOT, 'inventory.db');
  if (fs.existsSync(primary)) return primary;
  const backup = fs.readdirSync(ROOT)
    .filter(name => /^inventory\.db\.bak_/.test(name))
    .map(name => ({
      name,
      filePath: path.join(ROOT, name),
      mtimeMs: fs.statSync(path.join(ROOT, name)).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return backup ? backup.filePath : primary;
}

function tableExists(sqlite, table) {
  return Boolean(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function safeRows(sqlite, table) {
  if (!tableExists(sqlite, table)) return [];
  return sqlite.prepare(`SELECT * FROM ${table}`).all();
}

function cleanDoc(doc) {
  return Object.fromEntries(Object.entries(doc).filter(([, value]) => value !== undefined));
}

async function replaceCollection(db, name, docs) {
  if (!docs.length) {
    console.log(`${name}: no SQLite rows found`);
    return;
  }
  await db.collection(name).deleteMany({ migratedFromSqlite: true });
  await db.collection(name).insertMany(docs.map(cleanDoc));
  console.log(`${name}: migrated ${docs.length} rows`);
}

async function main() {
  if (!fs.existsSync(SQLITE_PATH)) {
    throw new Error(`SQLite database not found: ${SQLITE_PATH}`);
  }
  console.log(`Reading SQLite data from ${SQLITE_PATH}`);

  const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });
  const mongo = new MongoClient(MONGODB_URI);
  await mongo.connect();
  const db = mongo.db(MONGODB_DB);

  const cars = safeRows(sqlite, 'cars').map(row => ({
    sqliteId: row.id,
    brand: row.brand,
    model: row.model,
    year: row.year,
    price: row.price,
    mileage: row.mileage,
    fuel: row.fuel,
    condition: row.condition,
    status: row.status,
    imageUrl: row.image_url,
    description: row.description,
    createdAt: row.created_at || new Date().toISOString(),
    migratedFromSqlite: true
  }));

  const inquiries = safeRows(sqlite, 'inquiries').map(row => ({
    sqliteId: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    subject: row.subject,
    message: row.message,
    status: row.status || 'New',
    createdAt: row.created_at || new Date().toISOString(),
    migratedFromSqlite: true
  }));

  const visitors = safeRows(sqlite, 'visitors').map(row => ({
    sqliteId: row.id,
    token: row.token,
    label: row.label,
    ip: row.ip,
    userAgent: row.user_agent,
    currentPage: row.current_page,
    pageViews: row.page_views,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    migratedFromSqlite: true
  }));

  const users = safeRows(sqlite, 'users').map(row => ({
    sqliteId: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.password_hash,
    emailVerified: Boolean(row.email_verified),
    emailVerificationToken: row.email_verification_token,
    emailVerificationExpires: row.email_verification_expires,
    role: row.role || 'user',
    failedLoginAttempts: row.failed_login_attempts || 0,
    lockedUntil: row.locked_until,
    lastLogin: row.last_login,
    createdAt: row.created_at || new Date().toISOString(),
    migratedFromSqlite: true
  }));

  await replaceCollection(db, 'cars', cars);
  await replaceCollection(db, 'inquiries', inquiries);
  await replaceCollection(db, 'visitors', visitors);

  if (users.length) {
    for (const user of users) {
      await db.collection('users').updateOne(
        { $or: [{ username: user.username }, { email: user.email }] },
        { $setOnInsert: cleanDoc(user) },
        { upsert: true }
      );
    }
    console.log(`users: migrated/upserted ${users.length} rows`);
  } else {
    console.log('users: no SQLite rows found');
  }

  sqlite.close();
  await mongo.close();
  console.log(`Migration complete into MongoDB database "${MONGODB_DB}".`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
