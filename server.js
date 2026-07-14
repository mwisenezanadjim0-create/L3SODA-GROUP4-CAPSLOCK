const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const cluster = require('node:cluster');
const os = require('node:os');
const { MongoClient, ObjectId } = require('mongodb');
const sharp = require('sharp');
const nodemailer = require('nodemailer');

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const MONGODB_DB = process.env.MONGODB_DB || 'dodos_inventory';
const UPLOAD_DIR = path.join(ROOT, 'uploads', 'cars');
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const VISITOR_ACTIVE_MS = 1000 * 60 * 5;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'HAVUGIMANA DIEUDONNE';
const DEFAULT_ADMIN_PASSWORD = 'dodos@123';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const EMAIL_ENABLED = process.env.EMAIL_ENABLED === 'true';

const mongo = new MongoClient(MONGODB_URI);
let db;

if (IS_PRODUCTION && !process.env.ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD must be set in production');
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});

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

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const isPlainString = typeof body === 'string';
  const isObject = body !== null && typeof body === 'object';
  const payload = isPlainString || isBuffer ? body : isObject ? JSON.stringify(body) : String(body ?? '');
  res.writeHead(status, securityHeaders({
    ...(isObject && !isBuffer ? { 'Content-Type': 'application/json; charset=utf-8' } : { 'Content-Type': 'text/plain; charset=utf-8' }),
    ...headers
  }));
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

async function readJsonBody(req, limit = 1024 * 1024) {
  const text = (await readBody(req, limit)).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON');
  }
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, original] = String(stored || '').split(':');
  if (!salt || !original) return false;
  const attempt = hashPassword(password, salt).split(':')[1];
  const originalBuffer = Buffer.from(original, 'hex');
  const attemptBuffer = Buffer.from(attempt, 'hex');
  return originalBuffer.length === attemptBuffer.length && crypto.timingSafeEqual(originalBuffer, attemptBuffer);
}

function objectId(id) {
  return ObjectId.isValid(String(id || '')) ? new ObjectId(String(id)) : null;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanString(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self)',
    ...extra
  };
}

function cookieOptions(maxAge, { httpOnly = true, sameSite = 'Strict' } = {}) {
  return [
    httpOnly ? 'HttpOnly' : '',
    `SameSite=${sameSite}`,
    'Path=/',
    `Max-Age=${Math.floor(maxAge)}`,
    (IS_PRODUCTION || process.env.COOKIE_SECURE === 'true') ? 'Secure' : ''
  ].filter(Boolean).join('; ');
}

function publicDoc(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: String(_id), ...rest };
}

function serializeCar(row) {
  return {
    id: String(row._id),
    brand: escapeHtml(row.brand),
    model: row.model,
    year: row.year,
    price: row.price,
    mileage: row.mileage,
    fuel: row.fuel,
    condition: row.condition,
    status: row.status,
    imageUrl: row.imageUrl,
    previewVideoUrl: row.previewVideoUrl || '',
    description: row.description,
    createdAt: row.createdAt
  };
}

function serializeInquiry(row) {
  return {
    id: String(row._id),
    fullName: escapeHtml(row.fullName),
    email: escapeHtml(row.email),
    phone: escapeHtml(row.phone),
    subject: escapeHtml(row.subject),
    message: escapeHtml(row.message),
    status: row.status,
    createdAt: row.createdAt
  };
}

function serializeVisitor(row) {
  return {
    id: String(row._id),
    label: escapeHtml(row.label),
    ip: row.ip,
    userAgent: row.userAgent,
    currentPage: row.currentPage,
    pageViews: row.pageViews,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    active: Date.now() - row.lastSeen <= VISITOR_ACTIVE_MS
  };
}

async function sendInquiryEmails(inquiry) {
  if (!EMAIL_ENABLED) return;
  
  const settings = await db.collection('settings').findOne({ _id: 'site_settings' });
  const adminEmail = settings?.email || process.env.ADMIN_EMAIL || 'info@dodoscars.rw';
  const phone = settings?.phone || '+250 784 582 764';
  const address = settings?.address || 'Dubai Port, Kigali, Rwanda';
  
  const adminMailOptions = {
    from: `"Dodos Car Limited Alert" <${process.env.SMTP_USER}>`,
    to: adminEmail,
    subject: `🔥 New Car Inquiry: ${inquiry.subject}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <h2 style="color: #e85d26; border-bottom: 2px solid #e85d26; padding-bottom: 10px;">New Customer Inquiry Alert</h2>
        <p>You have received a new contact inquiry regarding Dodos Car Limited vehicles:</p>
        <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
          <tr>
            <td style="padding: 8px; font-weight: bold; width: 120px; border-bottom: 1px solid #f0f0f0;">Client Name:</td>
            <td style="padding: 8px; border-bottom: 1px solid #f0f0f0;">${inquiry.fullName}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #f0f0f0;">Email:</td>
            <td style="padding: 8px; border-bottom: 1px solid #f0f0f0;"><a href="mailto:${inquiry.email}" style="color: #e85d26; text-decoration: none;">${inquiry.email}</a></td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #f0f0f0;">Phone Number:</td>
            <td style="padding: 8px; border-bottom: 1px solid #f0f0f0;"><a href="tel:${inquiry.phone}" style="color: #e85d26; text-decoration: none;">${inquiry.phone}</a></td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #f0f0f0;">Subject:</td>
            <td style="padding: 8px; border-bottom: 1px solid #f0f0f0;">${inquiry.subject}</td>
          </tr>
        </table>
        <div style="margin-top: 20px; padding: 15px; background-color: #fcfcfc; border-left: 4px solid #e85d26; font-style: italic;">
          "${inquiry.message}"
        </div>
        <p style="margin-top: 25px; font-size: 12px; color: #888; text-align: center; border-top: 1px solid #eee; padding-top: 15px;">
          Dodos Car Limited Backend Portal System • Dubai Port, Rwanda
        </p>
      </div>
    `
  };
  
  const customerMailOptions = {
    from: `"Dodos Car Limited" <${process.env.SMTP_USER}>`,
    to: inquiry.email,
    subject: `Thank you for contacting Dodos Car Limited`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 8px;">
        <div style="text-align: center; margin-bottom: 20px;">
          <h1 style="color: #111; margin: 0; font-size: 24px; letter-spacing: 2px;">DODOS<span style="color:#e85d26">.</span></h1>
          <p style="margin: 0; font-size: 10px; text-transform: uppercase; letter-spacing: 2px; color: #888;">Your Perfect Ride Awaits</p>
        </div>
        <p>Dear <strong>${inquiry.fullName}</strong>,</p>
        <p>Thank you for reaching out to Dodos Car Limited. We have successfully received your inquiry regarding <strong>"${inquiry.subject}"</strong>.</p>
        <p>One of our premium luxury vehicle consultants is already reviewing your request and will contact you directly via phone or email within the next 24 hours to assist you.</p>
        <p>In the meantime, feel free to browse our latest hand-picked inventory at Dubai Port, Kigali.</p>
        <br>
        <p>Best regards,</p>
        <p><strong>The Dodos Car Limited Team</strong><br>${address}<br>Tel: ${phone}</p>
      </div>
    `
  };
  
  try {
    await Promise.all([
      transporter.sendMail(adminMailOptions),
      transporter.sendMail(customerMailOptions)
    ]);
    console.log(`Inquiry emails successfully dispatched to admin (${adminEmail}) and customer (${inquiry.email})`);
  } catch (error) {
    console.error('Nodemailer SMTP email dispatch failed:', error);
  }
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
    if (filename) files[name] = { filename, type, data: Buffer.from(bodyText, 'latin1') };
    else fields[name] = bodyText;
  }
  return { fields, files };
}

async function saveUpload(file) {
  if (!file || !file.data.length) return '';
  if (!/^image\/(png|jpe?g|webp|gif|svg\+xml)$/i.test(file.type)) throw new Error('Only image uploads are allowed');
  
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.webp`;
  const outputPath = path.join(UPLOAD_DIR, filename);
  
  try {
    await sharp(file.data)
      .rotate()
      .resize(1200, 900, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(outputPath);
    return `/uploads/cars/${filename}`;
  } catch (error) {
    console.error('Sharp compression failed, using raw fallback:', error);
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.data);
    return `/uploads/cars/${filename}`;
  }
}

function visitorIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

async function currentAdmin(req) {
  const token = getCookie(req, 'dodos_session');
  if (!token || token.length > 256) return null;
  const session = await db.collection('sessions').findOne({ token, expiresAt: { $gt: Date.now() } });
  if (!session) return null;
  const admin = await db.collection('admins').findOne({ _id: session.adminId });
  return admin ? { token, id: String(admin._id), username: admin.username } : null;
}

async function currentUser(req) {
  const token = getCookie(req, 'dodos_user_session');
  if (!token || token.length > 256) return null;
  const session = await db.collection('user_sessions').findOne({ token, expiresAt: { $gt: Date.now() } });
  if (!session) return null;
  const user = await db.collection('users').findOne({ _id: session.userId });
  return user ? { token, id: String(user._id), username: user.username, email: user.email, role: user.role || 'user' } : null;
}

async function requireAdmin(req, res) {
  const admin = await currentAdmin(req);
  if (!admin) {
    send(res, 401, { error: 'Admin login required' });
    return null;
  }
  return admin;
}

async function listCars() {
  const cars = await db.collection('cars').find({}).sort({ createdAt: -1, _id: -1 }).toArray();
  return cars.map(serializeCar);
}

async function listInquiries() {
  const inquiries = await db.collection('inquiries').find({}).sort({ createdAt: -1, _id: -1 }).toArray();
  return inquiries.map(serializeInquiry);
}

async function listVisitors() {
  const visitors = await db.collection('visitors').find({}).sort({ lastSeen: -1, _id: -1 }).toArray();
  return visitors.map(serializeVisitor);
}

async function touchVisitor(req, page = 'home') {
  let token = getCookie(req, 'dodos_visitor');
  const now = Date.now();
  const ip = visitorIp(req);
  const userAgent = String(req.headers['user-agent'] || 'Unknown browser').slice(0, 240);
  const currentPage = String(page || 'home').replace(/[^a-z0-9 -]/gi, '').slice(0, 60) || 'home';
  if (token) {
    const result = await db.collection('visitors').findOneAndUpdate(
      { token },
      { $set: { ip, userAgent, currentPage, lastSeen: now }, $inc: { pageViews: 1 } },
      { returnDocument: 'after' }
    );
    if (result) return { token, isNew: false };
  }
  token = crypto.randomBytes(24).toString('hex');
  const count = await db.collection('visitors').countDocuments();
  await db.collection('visitors').insertOne({
    token,
    label: `Visitor ${count + 1}`,
    ip,
    userAgent,
    currentPage,
    pageViews: 1,
    firstSeen: now,
    lastSeen: now
  });
  return { token, isNew: true };
}

const rateState = new Map();

// ── FIX 1: Clean up stale rate limit entries every 30 minutes to prevent memory leak ──
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateState.entries()) {
    if (now - val.firstTs > 15 * 60 * 1000) rateState.delete(key);
  }
}, 30 * 60 * 1000);

function rateLimit(key, { windowMs, max }) {
  const now = Date.now();
  const cur = rateState.get(key);
  if (!cur || now - cur.firstTs > windowMs) {
    rateState.set(key, { count: 1, firstTs: now });
    return { allowed: true, remaining: max - 1 };
  }
  cur.count += 1;
  return { allowed: cur.count <= max, remaining: Math.max(0, max - cur.count) };
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    send(res, 200, { ok: true, database: 'mongodb', dbName: MONGODB_DB });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/cars') {
    send(res, 200, { cars: await listCars() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/settings') {
    const settings = await db.collection('settings').findOne({ _id: 'site_settings' });
    send(res, 200, publicDoc(settings) || {});
    return;
  }

  if (req.method === 'POST' && pathname === '/api/inquiries') {
    const ip = visitorIp(req) || 'unknown';
    const rl = rateLimit(`inquiry:${ip}`, { windowMs: 15 * 60 * 1000, max: 8 });
    if (!rl.allowed) {
      send(res, 429, { error: 'Too many messages. Try again later.' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      send(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const inquiry = {
      fullName: cleanString(body.fullName, 120),
      email: cleanString(body.email, 160),
      phone: cleanString(body.phone, 60),
      subject: cleanString(body.subject, 160),
      message: cleanString(body.message, 2000),
      status: 'New',
      createdAt: new Date().toISOString()
    };
    if (!inquiry.fullName || !inquiry.email || !inquiry.phone || !inquiry.subject || !inquiry.message) {
      send(res, 400, { error: 'All fields are required' });
      return;
    }
    if (!isValidEmail(inquiry.email)) {
      send(res, 400, { error: 'A valid email address is required' });
      return;
    }
    await db.collection('inquiries').insertOne(inquiry);
    sendInquiryEmails(inquiry).catch(err => console.error('Failed to send inquiry emails:', err));
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/visitors/ping') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      send(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const visitor = await touchVisitor(req, body.page || 'home');
    send(res, 200, { ok: true }, visitor.isNew ? {
      'Set-Cookie': `dodos_visitor=${visitor.token}; ${cookieOptions(60 * 60 * 24 * 365, { httpOnly: false, sameSite: 'Lax' })}`
    } : {});
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/session') {
    const admin = await currentAdmin(req);
    send(res, 200, { authenticated: Boolean(admin), user: admin ? { username: admin.username } : null });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/login') {
    const ip = visitorIp(req) || 'unknown';
    const rl = rateLimit(`admin-login:${ip}`, { windowMs: 15 * 60 * 1000, max: 10 });
    if (!rl.allowed) {
      send(res, 429, { error: 'Too many login attempts. Try again later.' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      send(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const admin = await db.collection('admins').findOne({ username: cleanString(body.username, 120) });
    if (!admin || !verifyPassword(body.password || '', admin.passwordHash)) {
      send(res, 401, { error: 'Invalid credentials' });
      return;
    }
    const token = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(18).toString('hex');
    await db.collection('sessions').insertOne({
      token,
      adminId: admin._id,
      expiresAt: Date.now() + SESSION_TTL_MS,
      createdAt: new Date().toISOString()
    });
    send(res, 200, { ok: true, user: { username: admin.username } }, {
      'Set-Cookie': `dodos_session=${token}; ${cookieOptions(SESSION_TTL_MS / 1000)}, dodos_csrf=${csrfToken}; ${cookieOptions(SESSION_TTL_MS / 1000, { httpOnly: false })}`
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    const token = getCookie(req, 'dodos_session');
    if (token) await db.collection('sessions').deleteOne({ token });
    send(res, 200, { ok: true }, { 'Set-Cookie': `dodos_session=; ${cookieOptions(0)}, dodos_csrf=; ${cookieOptions(0, { httpOnly: false })}` });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/settings') {
    if (!await requireAdmin(req, res)) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      send(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const update = {
      phone: cleanString(body.phone, 80),
      email: cleanString(body.email, 160),
      address: cleanString(body.address, 300),
      whatsapp: cleanString(body.whatsapp, 300),
      instagram: cleanString(body.instagram, 300),
      tiktok: cleanString(body.tiktok, 300),
      hours: cleanString(body.hours, 300)
    };
    await db.collection('settings').updateOne({ _id: 'site_settings' }, { $set: update }, { upsert: true });
    send(res, 200, { ok: true, settings: update });
    return;
  }

  // Forgot password - request password reset
  if (req.method === 'POST' && pathname === '/api/admin/forgot-password') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      send(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const email = cleanString(body.email || '', 160).toLowerCase();
    const username = cleanString(body.username || '', 120);
    
    if (!email && !username) {
      send(res, 400, { error: 'Email or username is required' });
      return;
    }
    
    const admin = await db.collection('admins').findOne({ username });
    if (!admin) {
      send(res, 200, { ok: true, message: 'If an account exists, a reset link has been sent.' });
      return;
    }
    
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = Date.now() + 60 * 60 * 1000;
    
    await db.collection('admins').updateOne(
      { _id: admin._id },
      { $set: { resetToken, resetExpires } }
    );
    
    console.log(`Password reset token for ${username}: ${resetToken}`);
    console.log(`Reset link: http://localhost:${PORT}/reset-password?token=${resetToken}`);
    
    if (EMAIL_ENABLED && email) {
      try {
        const resetLink = `${process.env.FRONTEND_URL || `http://localhost:${PORT}`}/reset-password?token=${resetToken}`;
        await transporter.sendMail({
          from: `"Dodos Car Limited" <${process.env.SMTP_USER}>`,
          to: email,
          subject: 'Password Reset Request - Dodos Car Limited',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px;">
              <h2 style="color: #e85d26;">Password Reset Request</h2>
              <p>You requested to reset your password for Dodos Car Limited admin account.</p>
              <p>Click the link below to reset your password:</p>
              <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background: #e85d26; color: #fff; text-decoration: none; border-radius: 4px;">Reset Password</a>
              <p>This link expires in 1 hour.</p>
              <p>If you didn't request this, please ignore this email.</p>
            </div>
          `
        });
      } catch (err) {
        console.error('Failed to send reset email:', err);
      }
    }
    
    send(res, 200, { ok: true, message: 'If an account exists, a reset link has been sent.' });
    return;
  }

  // User forgot password
  if (req.method === 'POST' && pathname === '/api/user/forgot-password') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      send(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const email = cleanString(body.email || '', 160).toLowerCase();
    
    if (!email) {
      send(res, 400, { error: 'Email is required' });
      return;
    }
    
    const user = await db.collection('users').findOne({ email });
    if (!user) {
      send(res, 200, { ok: true, message: 'If an account exists, a reset link has been sent.' });
      return;
    }
    
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = Date.now() + 60 * 60 * 1000;
    
    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { resetToken, resetExpires } }
    );
    
    console.log(`User password reset token for ${email}: ${resetToken}`);
    
    if (EMAIL_ENABLED) {
      try {
        const resetLink = `${process.env.FRONTEND_URL || `http://localhost:${PORT}`}/reset-password?token=${resetToken}`;
        await transporter.sendMail({
          from: `"Dodos Car Limited" <${process.env.SMTP_USER}>`,
          to: email,
          subject: 'Password Reset Request - Dodos Car Limited',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px;">
              <h2 style="color: #e85d26;">Password Reset Request</h2>
              <p>You requested to reset your password for Dodos Car Limited account.</p>
              <p>Click the link below to reset your password:</p>
              <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background: #e85d26; color: #fff; text-decoration: none; border-radius: 4px;">Reset Password</a>
              <p>This link expires in 1 hour.</p>
              <p>If you didn't request this, please ignore this email.</p>
            </div>
          `
        });
      } catch (err) {
        console.error('Failed to send reset email:', err);
      }
    }
    
    send(res, 200, { ok: true, message: 'If an account exists, a reset link has been sent.' });
    return;
  }

  // Reset password with token
  if (req.method === 'POST' && pathname === '/api/admin/reset-password') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      send(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const token = cleanString(body.token || '', 128);
    const newPassword = String(body.newPassword || '');
    
    if (!token || newPassword.length < 6) {
      send(res, 400, { error: 'Token and new password (min 6 chars) are required' });
      return;
    }
    
    const admin = await db.collection('admins').findOne({
      resetToken: token,
      resetExpires: { $gt: Date.now() }
    });
    
    if (!admin) {
      send(res, 400, { error: 'Invalid or expired reset token' });
      return;
    }
    
    await db.collection('admins').updateOne(
      { _id: admin._id },
      { 
        $set: { passwordHash: hashPassword(newPassword) },
        $unset: { resetToken: '', resetExpires: '' }
      }
    );
    
    await db.collection('sessions').deleteMany({ adminId: admin._id });
    
    send(res, 200, { ok: true, message: 'Password reset successful' });
    return;
  }

  // User reset password with token
  if (req.method === 'POST' && pathname === '/api/user/reset-password') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      send(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const token = cleanString(body.token || '', 128);
    const newPassword = String(body.newPassword || '');
    
    if (!token || newPassword.length < 6) {
      send(res, 400, { error: 'Token and new password (min 6 chars) are required' });
      return;
    }
    
    const user = await db.collection('users').findOne({
      resetToken: token,
      resetExpires: { $gt: Date.now() }
    });
    
    if (!user) {
      send(res, 400, { error: 'Invalid or expired reset token' });
      return;
    }
    
    await db.collection('users').updateOne(
      { _id: user._id },
      { 
        $set: { passwordHash: hashPassword(newPassword) },
        $unset: { resetToken: '', resetExpires: '' }
      }
    );
    
    await db.collection('user_sessions').deleteMany({ userId: user._id });
    
    send(res, 200, { ok: true, message: 'Password reset successful' });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/change-password') {
    const adminUser = await requireAdmin(req, res);
    if (!adminUser) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      send(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    if (!currentPassword || newPassword.length < 6) {
      send(res, 400, { error: 'New password must be at least 6 characters long' });
      return;
    }
    const admin = await db.collection('admins').findOne({ _id: objectId(adminUser.id) });
    if (!admin || !verifyPassword(currentPassword, admin.passwordHash)) {
      send(res, 401, { error: 'Current password is incorrect' });
      return;
    }
    await db.collection('admins').updateOne(
      { _id: admin._id },
      { $set: { passwordHash: hashPassword(newPassword), updatedAt: new Date().toISOString() } }
    );
    send(res, 200, { ok: true, message: 'Password updated successfully' });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/cars') {
    if (!await requireAdmin(req, res)) return;
    send(res, 200, { cars: await listCars() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/inquiries') {
    if (!await requireAdmin(req, res)) return;
    send(res, 200, { inquiries: await listInquiries() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/visitors') {
    if (!await requireAdmin(req, res)) return;
    send(res, 200, { visitors: await listVisitors(), activeWindowMs: VISITOR_ACTIVE_MS });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/active-users') {
    if (!await requireAdmin(req, res)) return;
    const sessions = await db.collection('user_sessions').find({ expiresAt: { $gt: Date.now() } }).sort({ createdAt: -1 }).toArray();
    const users = await db.collection('users').find({ _id: { $in: sessions.map(session => session.userId) } }).toArray();
    const userById = new Map(users.map(user => [String(user._id), user]));
    const activeUsers = sessions.map(session => {
      const user = userById.get(String(session.userId));
      return {
        token: session.token,
        username: user?.username || 'Unknown',
        email: user?.email || '',
        created_at: session.createdAt,
        expires_at: session.expiresAt
      };
    });
    send(res, 200, { activeUsers });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/stats') {
    if (!await requireAdmin(req, res)) return;
    const [totalCars, availableCars, soldCars, inquiries, users, activeUsers, visitors] = await Promise.all([
      db.collection('cars').countDocuments(),
      db.collection('cars').countDocuments({ status: /available/i }),
      db.collection('cars').countDocuments({ status: /sold/i }),
      db.collection('inquiries').countDocuments(),
      db.collection('users').countDocuments(),
      db.collection('user_sessions').countDocuments({ expiresAt: { $gt: Date.now() } }),
      db.collection('visitors').countDocuments()
    ]);
    send(res, 200, {
      totalCars,
      availableCars,
      soldCars,
      inquiries,
      users,
      activeUsers,
      visitors,
      uptimeSeconds: Math.round(process.uptime())
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/user/register') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      send(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const username = cleanString(body.username, 80);
    const email = cleanString(body.email, 160).toLowerCase();
    const password = String(body.password || '');
    if (!username || !email || password.length < 6) {
      send(res, 400, { error: 'Username, email, and password (min 6 chars) are required' });
      return;
    }
    if (!isValidEmail(email)) {
      send(res, 400, { error: 'A valid email address is required' });
      return;
    }
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    const emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000;
    try {
      await db.collection('users').insertOne({
        username,
        email,
        passwordHash: hashPassword(password),
        emailVerified: false,
        emailVerificationToken,
        emailVerificationExpires,
        role: 'user',
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLogin: null,
        createdAt: new Date().toISOString()
      });
      if (EMAIL_ENABLED) {
        const verificationLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-email?token=${emailVerificationToken}`;
        console.log(`Verification link for ${email}: ${verificationLink}`);
      }
      send(res, 201, { ok: true, message: 'Registration successful', requiresVerification: EMAIL_ENABLED, user: { username, email } });
    } catch (error) {
      if (error.code === 11000) send(res, 409, { error: 'Username or email already exists' });
      else throw error;
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/user/login') {
    const ip = visitorIp(req) || 'unknown';
    const rl = rateLimit(`user-login:${ip}`, { windowMs: 15 * 60 * 1000, max: 25 });
    if (!rl.allowed) {
      send(res, 429, { error: 'Too many login attempts. Try again later.' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      send(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const login = cleanString(body.username, 160);
    const user = await db.collection('users').findOne({ $or: [{ username: login }, { email: login.toLowerCase() }] });
    if (!user || !verifyPassword(body.password || '', user.passwordHash)) {
      send(res, 401, { error: 'Invalid credentials' });
      return;
    }
    const token = crypto.randomBytes(32).toString('hex');
    await db.collection('user_sessions').insertOne({
      token,
      userId: user._id,
      expiresAt: Date.now() + SESSION_TTL_MS,
      createdAt: new Date().toISOString()
    });
    await db.collection('users').updateOne({ _id: user._id }, { $set: { lastLogin: Date.now() } });
    send(res, 200, { ok: true, user: { username: user.username, email: user.email } }, {
      'Set-Cookie': `dodos_user_session=${token}; ${cookieOptions(SESSION_TTL_MS / 1000)}`
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/user/logout') {
    const token = getCookie(req, 'dodos_user_session');
    if (token) await db.collection('user_sessions').deleteOne({ token });
    send(res, 200, { ok: true }, { 'Set-Cookie': `dodos_user_session=; ${cookieOptions(0)}` });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/user/session') {
    const user = await currentUser(req);
    send(res, 200, { authenticated: Boolean(user), user: user ? { username: user.username, email: user.email, role: user.role } : null });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/user/verify-email') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (!token) {
      send(res, 400, { error: 'Verification token is required' });
      return;
    }
    const result = await db.collection('users').findOneAndUpdate(
      { emailVerificationToken: token, emailVerificationExpires: { $gt: Date.now() } },
      { $set: { emailVerified: true }, $unset: { emailVerificationToken: '', emailVerificationExpires: '' } },
      { returnDocument: 'after' }
    );
    if (!result) {
      send(res, 400, { error: 'Invalid or expired verification token' });
      return;
    }
    send(res, 200, { ok: true, message: 'Email verified successfully' });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/user/resend-verification') {
    const user = await currentUser(req);
    if (!user) {
      send(res, 401, { error: 'Authentication required' });
      return;
    }
    const userData = await db.collection('users').findOne({ _id: objectId(user.id) });
    if (!userData || userData.emailVerified) {
      send(res, 400, { error: 'Email already verified' });
      return;
    }
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    await db.collection('users').updateOne(
      { _id: userData._id },
      { $set: { emailVerificationToken, emailVerificationExpires: Date.now() + 24 * 60 * 60 * 1000 } }
    );
    if (EMAIL_ENABLED) {
      const verificationLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-email?token=${emailVerificationToken}`;
      console.log(`Verification link for ${user.email}: ${verificationLink}`);
    }
    send(res, 200, { ok: true, message: 'Verification email sent' });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/cars') {
    if (!await requireAdmin(req, res)) return;
    const { fields, files } = parseMultipart(await readBody(req, MAX_UPLOAD_BYTES), req.headers['content-type']);
    const imageUrl = await saveUpload(files.image) || cleanString(fields.imageUrl, 300);
    if (!fields.brand || !fields.model || !fields.year || !fields.price || !imageUrl) {
      send(res, 400, { error: 'Brand, model, year, price, and photo are required' });
      return;
    }
    await db.collection('cars').insertOne({
      brand: cleanString(fields.brand, 100),
      model: cleanString(fields.model, 100),
      year: Number(fields.year),
      price: Number(String(fields.price).replace(/[^\d]/g, '')),
      mileage: cleanString(fields.mileage || '0 km', 80),
      fuel: cleanString(fields.fuel || 'Petrol', 60),
      condition: cleanString(fields.condition || 'New', 60),
      status: cleanString(fields.status || 'Available', 60),
      imageUrl,
      previewVideoUrl: cleanString(fields.previewVideoUrl || '', 300),
      description: cleanString(fields.description || '', 2000),
      createdAt: new Date().toISOString()
    });
    send(res, 201, { ok: true, cars: await listCars() });
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/admin/cars/')) {
    if (!await requireAdmin(req, res)) return;
    const id = objectId(pathname.split('/').pop());
    if (!id) {
      send(res, 400, { error: 'Invalid car id' });
      return;
    }
    await db.collection('cars').deleteOne({ _id: id });
    send(res, 200, { ok: true, cars: await listCars() });
    return;
  }

  send(res, 404, { error: 'API route not found' });
}

// ── FIX 2: Static file MIME types with cache durations ──
const STATIC_TYPES = {
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

// Cache durations per type: images/assets cached 7 days, HTML 1 hour
const CACHE_CONTROL = {
  '.html': 'public, max-age=3600',
  '.js':   'public, max-age=86400',
  '.css':  'public, max-age=86400',
  '.jpg':  'public, max-age=604800',
  '.jpeg': 'public, max-age=604800',
  '.png':  'public, max-age=604800',
  '.webp': 'public, max-age=604800',
  '.gif':  'public, max-age=604800',
  '.pdf':  'public, max-age=86400'
};

// Compressible text types
const COMPRESSIBLE = new Set([
  'text/html; charset=utf-8',
  'text/javascript; charset=utf-8',
  'text/css; charset=utf-8'
]);

// ── FIX 3: gzip compression helper ──
function sendCompressed(req, res, status, data, contentType, extraHeaders = {}) {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  const headers = securityHeaders({
    'Content-Type': contentType,
    ...extraHeaders
  });

  if (COMPRESSIBLE.has(contentType) && acceptEncoding.includes('gzip')) {
    zlib.gzip(data, (err, compressed) => {
      if (err) {
        res.writeHead(status, headers);
        res.end(req.method === 'HEAD' ? undefined : data);
        return;
      }
      res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      res.end(req.method === 'HEAD' ? undefined : compressed);
    });
  } else {
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  }
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
    return;
  }
  let requested;
  try {
    requested = pathname === '/' || pathname === '/claude' || pathname === '/manage-dodos-showroom-9f8d2b'
      ? 'claude.html'
      : decodeURIComponent(pathname.slice(1));
  } catch {
    send(res, 400, 'Bad request');
    return;
  }
  const filePath = path.resolve(ROOT, requested);
  const relativePath = path.relative(ROOT, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    send(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = STATIC_TYPES[ext] || 'application/octet-stream';
    const cacheControl = CACHE_CONTROL[ext] || 'public, max-age=3600';

    sendCompressed(req, res, 200, data, contentType, {
      'Cache-Control': cacheControl
    });
  });
}

async function ensureMongo() {
  await mongo.connect();
  db = mongo.db(MONGODB_DB);
  await Promise.all([
    db.collection('admins').createIndex({ username: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ token: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('users').createIndex({ username: 1 }, { unique: true }),
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('user_sessions').createIndex({ token: 1 }, { unique: true }),
    db.collection('user_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('cars').createIndex({ createdAt: -1 }),
    db.collection('cars').createIndex({ status: 1 }),
    db.collection('inquiries').createIndex({ createdAt: -1 }),
    db.collection('visitors').createIndex({ token: 1 }, { unique: true }),
    db.collection('visitors').createIndex({ lastSeen: -1 })
  ]);

  await db.collection('admins').updateOne(
    { username: ADMIN_USERNAME },
    {
      $set: {
        username: ADMIN_USERNAME,
        updatedAt: new Date().toISOString()
      },
      $setOnInsert: {
        passwordHash: hashPassword(ADMIN_PASSWORD),
        createdAt: new Date().toISOString()
      }
    },
    { upsert: true }
  );

  const settingsCount = await db.collection('settings').countDocuments();
  if (settingsCount === 0) {
    await db.collection('settings').insertOne({
      _id: 'site_settings',
      phone: '0784 582 764',
      email: 'info@dodoscars.rw',
      address: 'Dubai Port, Kigali, Rwanda, East Africa',
      whatsapp: 'https://wa.me/250784582764',
      instagram: 'https://www.instagram.com/dodoscarlimited/',
      tiktok: 'https://www.tiktok.com/@dodoscarlimited',
      hours: 'Mon–Sat: 8:00am – 6:00pm\nSunday: 10:00am – 4:00pm'
    });
  }
}

async function start() {
  await ensureMongo();
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, `http://${req.headers.host}`);
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname);
        return;
      }
      serveStatic(req, res, pathname);
    } catch (error) {
      console.error(error);
      send(res, 500, { error: error.message || 'Server error' });
    }
  });

  server.listen(PORT, () => {
    console.log(`Dodos MongoDB website running at http://127.0.0.1:${PORT}`);
    console.log(`MongoDB database: ${MONGODB_DB}`);
    console.log(`Admin username: ${ADMIN_USERNAME}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('Using the development admin password fallback. Set ADMIN_PASSWORD in .env before deployment.');
    }
    // ── FIX 4: Log which worker is running (cluster mode) ──
    if (cluster.worker) {
      console.log(`Worker ${cluster.worker.id} started (PID ${process.pid})`);
    }
  });
}

// ── FIX 4: Cluster mode — use all CPU cores ──
const clusterWorkers = Number(process.env.WEB_CONCURRENCY || (IS_PRODUCTION ? os.cpus().length : 1));
const shouldCluster = cluster.isPrimary && clusterWorkers > 1 && process.env.CLUSTER_ENABLED !== 'false';

if (shouldCluster) {
  console.log(`Primary process ${process.pid} starting ${clusterWorkers} workers...`);
  for (let i = 0; i < clusterWorkers; i++) {
    cluster.fork();
  }
  cluster.on('exit', (worker, code, signal) => {
    console.warn(`Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    cluster.fork();
  });
} else {
  start().catch(error => {
    console.error('Failed to start MongoDB backend:', error);
    process.exit(1);
  });
}
