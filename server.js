const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'inventory.db');
const UPLOAD_DIR = path.join(ROOT, 'uploads', 'cars');
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const VISITOR_ACTIVE_MS = 1000 * 60 * 5;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dodos2024';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all().map(column => column.name);
if (sessionColumns.length && !sessionColumns.includes('token')) {
  db.exec('DROP TABLE sessions');
}
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS cars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    year INTEGER NOT NULL,
    price INTEGER NOT NULL,
    mileage TEXT NOT NULL,
    fuel TEXT NOT NULL,
    condition TEXT NOT NULL,
    status TEXT NOT NULL,
    image_url TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'New',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS visitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    ip TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    current_page TEXT NOT NULL DEFAULT 'home',
    page_views INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
`);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, original] = String(stored).split(':');
  if (!salt || !original) return false;
  const attempt = hashPassword(password, salt).split(':')[1];
  return crypto.timingSafeEqual(Buffer.from(original, 'hex'), Buffer.from(attempt, 'hex'));
}

const adminCount = db.prepare('SELECT COUNT(*) AS count FROM admins').get().count;
if (!adminCount) {
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(
    ADMIN_USERNAME,
    hashPassword(ADMIN_PASSWORD)
  );
  console.log(`Admin created. Username: ${ADMIN_USERNAME}. Change ADMIN_PASSWORD before publishing.`);
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain',
    ...headers
  });
  res.end(payload);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
}

function currentAdmin(req) {
  const token = getCookie(req, 'dodos_session');
  if (!token) return null;
  const row = db.prepare(`
    SELECT sessions.token, admins.id, admins.username
    FROM sessions JOIN admins ON admins.id = sessions.admin_id
    WHERE sessions.token = ? AND sessions.expires_at > ?
  `).get(token, Date.now());
  return row || null;
}

function currentUser(req) {
  const token = getCookie(req, 'dodos_user_session');
  if (!token) return null;
  const row = db.prepare(`
    SELECT user_sessions.token, users.id, users.username, users.email
    FROM user_sessions JOIN users ON users.id = user_sessions.user_id
    WHERE user_sessions.token = ? AND user_sessions.expires_at > ?
  `).get(token, Date.now());
  return row || null;
}

function requireAdmin(req, res) {
  const admin = currentAdmin(req);
  if (!admin) {
    send(res, 401, { error: 'Admin login required' });
    return null;
  }
  return admin;
}

function serializeCar(row) {
  return {
    id: row.id,
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
    createdAt: row.created_at
  };
}

function serializeInquiry(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    subject: row.subject,
    message: row.message,
    status: row.status,
    createdAt: row.created_at
  };
}

function serializeVisitor(row) {
  return {
    id: row.id,
    label: row.label,
    ip: row.ip,
    userAgent: row.user_agent,
    currentPage: row.current_page,
    pageViews: row.page_views,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    active: Date.now() - row.last_seen <= VISITOR_ACTIVE_MS
  };
}

function parseMultipart(buffer, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '')?.[1] || /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '')?.[2];
  if (!boundary) throw new Error('Missing form boundary');
  const raw = buffer.toString('latin1');
  const parts = raw.split(`--${boundary}`).slice(1, -1);
  const fields = {};
  const files = {};
  for (const part of parts) {
    const cleaned = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const splitAt = cleaned.indexOf('\r\n\r\n');
    if (splitAt === -1) continue;
    const headerText = cleaned.slice(0, splitAt);
    const bodyText = cleaned.slice(splitAt + 4);
    const name = /name="([^"]+)"/.exec(headerText)?.[1];
    const filename = /filename="([^"]*)"/.exec(headerText)?.[1];
    const type = /Content-Type:\s*([^\r\n]+)/i.exec(headerText)?.[1] || 'application/octet-stream';
    if (!name) continue;
    if (filename) {
      files[name] = { filename, type, data: Buffer.from(bodyText, 'latin1') };
    } else {
      fields[name] = bodyText;
    }
  }
  return { fields, files };
}

function saveUpload(file) {
  if (!file || !file.data.length) return '';
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
    throw new Error('Only image uploads are allowed');
  }
  const ext = path.extname(file.filename).toLowerCase() || '.jpg';
  const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.data);
  return `/uploads/cars/${filename}`;
}

function listCars() {
  return db.prepare('SELECT * FROM cars ORDER BY created_at DESC, id DESC').all().map(serializeCar);
}

function listInquiries() {
  return db.prepare('SELECT * FROM inquiries ORDER BY created_at DESC, id DESC').all().map(serializeInquiry);
}

function visitorIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function touchVisitor(req, page = 'home') {
  let token = getCookie(req, 'dodos_visitor');
  const now = Date.now();
  const ip = visitorIp(req);
  const userAgent = String(req.headers['user-agent'] || 'Unknown browser').slice(0, 240);
  const cleanPage = String(page || 'home').replace(/[^a-z0-9 -]/gi, '').slice(0, 60) || 'home';
  if (token) {
    const existing = db.prepare('SELECT id FROM visitors WHERE token = ?').get(token);
    if (existing) {
      db.prepare(`
        UPDATE visitors
        SET ip = ?, user_agent = ?, current_page = ?, page_views = page_views + 1, last_seen = ?
        WHERE token = ?
      `).run(ip, userAgent, cleanPage, now, token);
      return { token, isNew: false };
    }
  }
  token = crypto.randomBytes(24).toString('hex');
  const label = `Visitor ${db.prepare('SELECT COUNT(*) AS count FROM visitors').get().count + 1}`;
  db.prepare(`
    INSERT INTO visitors (token, label, ip, user_agent, current_page, page_views, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(token, label, ip, userAgent, cleanPage, now, now);
  return { token, isNew: true };
}

function listVisitors() {
  return db.prepare('SELECT * FROM visitors ORDER BY last_seen DESC, id DESC').all().map(serializeVisitor);
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/cars') {
    send(res, 200, { cars: listCars() });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/inquiries') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const fullName = String(body.fullName || '').trim();
    const email = String(body.email || '').trim();
    const phone = String(body.phone || '').trim();
    const subject = String(body.subject || '').trim();
    const message = String(body.message || '').trim();
    if (!fullName || !email || !phone || !subject || !message) {
      send(res, 400, { error: 'All fields are required' });
      return;
    }
    db.prepare(`
      INSERT INTO inquiries (full_name, email, phone, subject, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(fullName, email, phone, subject, message);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/visitors/ping') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const visitor = touchVisitor(req, body.page || 'home');
    send(res, 200, { ok: true }, visitor.isNew ? {
      'Set-Cookie': `dodos_visitor=${visitor.token}; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 365}`
    } : {});
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/session') {
    const admin = currentAdmin(req);
    send(res, 200, { authenticated: Boolean(admin), user: admin ? { username: admin.username } : null });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/login') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(body.username || '');
    if (!admin || !verifyPassword(body.password || '', admin.password_hash)) {
      send(res, 401, { error: 'Invalid credentials' });
      return;
    }
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, admin_id, expires_at) VALUES (?, ?, ?)').run(token, admin.id, Date.now() + SESSION_TTL_MS);
    send(res, 200, { ok: true, user: { username: admin.username } }, {
      'Set-Cookie': `dodos_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    const token = getCookie(req, 'dodos_session');
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    send(res, 200, { ok: true }, { 'Set-Cookie': 'dodos_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/cars') {
    if (!requireAdmin(req, res)) return;
    send(res, 200, { cars: listCars() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/inquiries') {
    if (!requireAdmin(req, res)) return;
    send(res, 200, { inquiries: listInquiries() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/visitors') {
    if (!requireAdmin(req, res)) return;
    send(res, 200, { visitors: listVisitors(), activeWindowMs: VISITOR_ACTIVE_MS });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/active-users') {
    if (!requireAdmin(req, res)) return;
    const activeUsers = db.prepare(`
      SELECT user_sessions.token, users.username, users.email, user_sessions.created_at, user_sessions.expires_at
      FROM user_sessions JOIN users ON users.id = user_sessions.user_id
      WHERE user_sessions.expires_at > ?
      ORDER BY user_sessions.created_at DESC
    `).all(Date.now());
    send(res, 200, { activeUsers });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/user/register') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const username = String(body.username || '').trim();
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    if (!username || !email || !password || password.length < 6) {
      send(res, 400, { error: 'Username, email, and password (min 6 chars) are required' });
      return;
    }
    try {
      db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)').run(
        username, email, hashPassword(password)
      );
      send(res, 201, { ok: true });
    } catch (e) {
      if (e.message.includes('UNIQUE constraint failed')) {
        send(res, 409, { error: 'Username or email already exists' });
      } else {
        send(res, 500, { error: 'Database error' });
      }
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/user/login') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(body.username || '', body.username || '');
    if (!user || !verifyPassword(body.password || '', user.password_hash)) {
      send(res, 401, { error: 'Invalid credentials' });
      return;
    }
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO user_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, Date.now() + SESSION_TTL_MS);
    send(res, 200, { ok: true, user: { username: user.username, email: user.email } }, {
      'Set-Cookie': `dodos_user_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/user/logout') {
    const token = getCookie(req, 'dodos_user_session');
    if (token) db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
    send(res, 200, { ok: true }, { 'Set-Cookie': 'dodos_user_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/user/session') {
    const user = currentUser(req);
    send(res, 200, { authenticated: Boolean(user), user: user ? { username: user.username, email: user.email } : null });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/cars') {
    if (!requireAdmin(req, res)) return;
    const { fields, files } = parseMultipart(await readBody(req, MAX_UPLOAD_BYTES), req.headers['content-type']);
    const imageUrl = saveUpload(files.image) || fields.imageUrl || '';
    if (!fields.brand || !fields.model || !fields.year || !fields.price || !imageUrl) {
      send(res, 400, { error: 'Brand, model, year, price, and photo are required' });
      return;
    }
    db.prepare(`
      INSERT INTO cars (brand, model, year, price, mileage, fuel, condition, status, image_url, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fields.brand.trim(),
      fields.model.trim(),
      Number(fields.year),
      Number(String(fields.price).replace(/[^\d]/g, '')),
      fields.mileage?.trim() || '0 km',
      fields.fuel || 'Petrol',
      fields.condition || 'New',
      fields.status || 'Available',
      imageUrl,
      fields.description?.trim() || ''
    );
    send(res, 201, { ok: true, cars: listCars() });
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/admin/cars/')) {
    if (!requireAdmin(req, res)) return;
    const id = Number(pathname.split('/').pop());
    db.prepare('DELETE FROM cars WHERE id = ?').run(id);
    send(res, 200, { ok: true, cars: listCars() });
    return;
  }

  send(res, 404, { error: 'API route not found' });
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' || pathname === '/admin' ? 'claude.html' : pathname.slice(1);
  const filePath = path.resolve(ROOT, requested);
  if (!filePath.startsWith(ROOT)) {
    send(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.pdf': 'application/pdf'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (error) {
    send(res, 500, { error: error.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Dodos website running at http://127.0.0.1:${PORT}`);
});
