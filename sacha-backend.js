const http = require('node:http');
const crypto = require('node:crypto');
const { MongoClient, ObjectId } = require('mongodb');

const PORT = Number(process.env.SACHA_PORT || process.env.PORT || 4000);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const MONGODB_DB = process.env.SACHA_MONGODB_DB || 'sacha_taste';
const RESTAURANT_NAME = process.env.RESTAURANT_NAME || "Sacha's Taste";
const ADMIN_TOKEN = process.env.SACHA_ADMIN_TOKEN || 'sacha-admin-dev';
const SACHA_WHATSAPP = process.env.SACHA_WHATSAPP || '+250780000000';
const CORS_ORIGIN = process.env.SACHA_CORS_ORIGIN || '*';

const twilioConfig = {
  accountSid: process.env.TWILIO_ACCOUNT_SID || '',
  authToken: process.env.TWILIO_AUTH_TOKEN || '',
  smsFrom: process.env.TWILIO_FROM_SMS || '',
  whatsappFrom: process.env.TWILIO_FROM_WHATSAPP || ''
};

const client = new MongoClient(MONGODB_URI);
let db;

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    ...headers
  });
  res.end(JSON.stringify(body));
}

function notFound(res) {
  json(res, 404, { error: 'Route not found' });
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON');
  }
}

function requireAdmin(req, res) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const token = req.headers['x-admin-token'] || bearer;
  if (token !== ADMIN_TOKEN) {
    json(res, 401, { error: 'Admin token required' });
    return false;
  }
  return true;
}

function cleanString(value, max = 240) {
  return String(value || '').trim().slice(0, max);
}

function toObjectId(value) {
  if (!ObjectId.isValid(String(value || ''))) return null;
  return new ObjectId(String(value));
}

function publicId(doc) {
  return { ...doc, id: doc._id.toString(), _id: undefined };
}

function formatMoney(amount) {
  return `${Number(amount || 0).toLocaleString('en-US')} RWF`;
}

function buildOrderNumber() {
  return `ST-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function getKigaliNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Kigali' }));
}

function minutesOfDay(time) {
  const [hour, minute] = String(time).split(':').map(Number);
  return hour * 60 + minute;
}

async function restaurantStatus() {
  const now = getKigaliNow();
  const weekday = now.getDay();
  const day = await db.collection('operating_hours').findOne({ weekday });
  if (!day || !day.isOpen) {
    return { open: false, currentDay: day?.dayName || null, reason: 'Closed today' };
  }
  const current = now.getHours() * 60 + now.getMinutes();
  const opens = minutesOfDay(day.opensAt);
  const closes = minutesOfDay(day.closesAt);
  return {
    open: current >= opens && current <= closes,
    currentDay: day.dayName,
    reason: `Open ${day.opensAt}-${day.closesAt}`,
    opensAt: day.opensAt,
    closesAt: day.closesAt
  };
}

async function sendTwilio(channel, recipient, message) {
  const isWhatsapp = channel === 'whatsapp';
  const from = isWhatsapp ? twilioConfig.whatsappFrom : twilioConfig.smsFrom;
  if (!twilioConfig.accountSid || !twilioConfig.authToken || !from) {
    return { status: 'queued', provider: 'log', detail: 'Twilio credentials not configured' };
  }

  const to = isWhatsapp && !recipient.startsWith('whatsapp:')
    ? `whatsapp:${recipient}`
    : recipient;
  const body = new URLSearchParams({ To: to, From: from, Body: message });
  const auth = Buffer.from(`${twilioConfig.accountSid}:${twilioConfig.authToken}`).toString('base64');
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioConfig.accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const data = await response.json().catch(() => ({}));
  return {
    status: response.ok ? 'sent' : 'failed',
    provider: 'twilio',
    detail: data.sid || data.message || `HTTP ${response.status}`
  };
}

async function recordNotification(orderId, channel, recipient, message) {
  let delivery;
  try {
    delivery = await sendTwilio(channel, recipient, message);
  } catch (error) {
    delivery = { status: 'failed', provider: 'twilio', detail: error.message };
  }
  const doc = {
    orderId,
    channel,
    recipient,
    message,
    status: delivery.status,
    provider: delivery.provider,
    detail: delivery.detail,
    createdAt: new Date()
  };
  await db.collection('notification_logs').insertOne(doc);
  return doc;
}

async function notifyOrder(order, zone, items) {
  const itemSummary = items.map(item => `${item.quantity}x ${item.name}`).join(', ');
  const customerChannel = order.customerWhatsapp ? 'whatsapp' : 'sms';
  const customerRecipient = order.customerWhatsapp || order.customerPhone;
  const customerMessage = `${RESTAURANT_NAME}: Order ${order.orderNumber} received. Total ${formatMoney(order.total)} incl. delivery to ${zone.name}. ETA about ${zone.etaMinutes} min.`;
  const adminMessage = `New ${RESTAURANT_NAME} order ${order.orderNumber}: ${order.customerName}, ${order.customerPhone}, ${zone.name}, ${formatMoney(order.total)}. Items: ${itemSummary}.`;
  await Promise.all([
    recordNotification(order._id, customerChannel, customerRecipient, customerMessage),
    recordNotification(order._id, 'whatsapp', SACHA_WHATSAPP, adminMessage)
  ]);
}

async function ensureIndexes() {
  await db.collection('menu_items').createIndex({ sortOrder: 1, name: 1 });
  await db.collection('menu_items').createIndex({ name: 1 }, { unique: true });
  await db.collection('delivery_zones').createIndex({ district: 1, name: 1 });
  await db.collection('delivery_zones').createIndex({ name: 1 }, { unique: true });
  await db.collection('orders').createIndex({ orderNumber: 1 }, { unique: true });
  await db.collection('orders').createIndex({ createdAt: -1 });
  await db.collection('notification_logs').createIndex({ orderId: 1, createdAt: -1 });
}

async function seedData() {
  const menuCount = await db.collection('menu_items').countDocuments();
  if (!menuCount) {
    await db.collection('menu_items').insertMany([
      { name: 'Flame Grill Combo', description: 'Flame-grilled meat, golden fries, salad, and Sacha sauce.', category: 'Combos & Specials', price: 12000, imageUrl: 'assets/sample_food (1).png', rating: 4.8, badge: 'Popular', isFeatured: true, isAvailable: true, sortOrder: 1 },
      { name: 'Suya Supreme', description: 'Traditional suya spice, grilled skewers, plantain, and pepper sauce.', category: 'Combos & Specials', price: 8500, imageUrl: 'assets/sample_food (3).jpg', rating: 4.7, badge: 'Popular', isFeatured: true, isAvailable: true, sortOrder: 2 },
      { name: 'New Rice Recipe', description: 'Jollof-style rice with tender chicken and fresh herbs.', category: 'Rice Meals', price: 9500, imageUrl: 'assets/sample_food (5).png', rating: 4.6, badge: 'New', isFeatured: true, isAvailable: true, sortOrder: 3 },
      { name: 'Family Feast Box', description: 'A sharing platter with grilled meats, fries, rice, sauces, and salad.', category: 'Family Meals', price: 25000, imageUrl: 'assets/sample_food (6).png', rating: 4.8, badge: 'Share', isFeatured: true, isAvailable: true, sortOrder: 4 },
      { name: 'Street King Special', description: 'A bold street-food plate with smoky meat, fries, and spicy slaw.', category: 'Combos & Specials', price: 11000, imageUrl: 'assets/sample_food (4).jpg', rating: 4.7, badge: 'Chef Pick', isFeatured: true, isAvailable: true, sortOrder: 5 },
      { name: 'Afro Crunch Salad', description: 'Fresh greens, crunchy vegetables, grilled chicken, and house dressing.', category: 'Fresh Salads', price: 6500, imageUrl: 'assets/sample_food (3).jpg', rating: 4.5, badge: 'Fresh', isFeatured: false, isAvailable: true, sortOrder: 6 },
      { name: 'Golden Spiced Fries', description: 'Crispy fries tossed in Sacha spice with creamy garlic dip.', category: 'Sides', price: 3500, imageUrl: 'assets/sample_food (5).png', rating: 4.5, badge: '', isFeatured: false, isAvailable: true, sortOrder: 7 },
      { name: 'Homemade Ginger Drink', description: 'Cold ginger drink with citrus and a clean spicy finish.', category: 'Drinks', price: 2500, imageUrl: 'assets/sample_food (1).png', rating: 4.4, badge: '', isFeatured: false, isAvailable: true, sortOrder: 8 }
    ]);
  }

  const zoneCount = await db.collection('delivery_zones').countDocuments();
  if (!zoneCount) {
    await db.collection('delivery_zones').insertMany([
      { name: 'Nyarugenge Central', district: 'Nyarugenge', sectors: ['Gitega', 'Kigali', 'Kimisagara', 'Muhima', 'Nyakabanda', 'Nyamirambo', 'Nyarugenge', 'Rwezamenyo'], fee: 1500, etaMinutes: 25, isActive: true, notes: 'Dense central Kigali route.' },
      { name: 'Outer Nyarugenge', district: 'Nyarugenge', sectors: ['Kanyinya', 'Mageragere'], fee: 2500, etaMinutes: 40, isActive: true, notes: 'Longer hillside routes.' },
      { name: 'Gasabo Urban', district: 'Gasabo', sectors: ['Gisozi', 'Kacyiru', 'Kimihurura', 'Kimironko', 'Remera'], fee: 2000, etaMinutes: 30, isActive: true, notes: 'Core Gasabo neighborhoods around KN/KG routes.' },
      { name: 'Gasabo East and North', district: 'Gasabo', sectors: ['Bumbogo', 'Gatsata', 'Gikomero', 'Ginyinya', 'Jabana', 'Jali', 'Ndera', 'Nduba', 'Rusororo', 'Rutunga'], fee: 3500, etaMinutes: 50, isActive: true, notes: 'Longer Gasabo routes; confirm exact address before dispatch.' },
      { name: 'Kicukiro Urban', district: 'Kicukiro', sectors: ['Gatenga', 'Gikondo', 'Kagarama', 'Kicukiro', 'Niboye', 'Nyarugunga'], fee: 2000, etaMinutes: 30, isActive: true, notes: 'Core Kicukiro neighborhoods around KK routes.' },
      { name: 'Kicukiro Outer', district: 'Kicukiro', sectors: ['Gahanga', 'Kanombe', 'Kigarama', 'Masaka'], fee: 3000, etaMinutes: 45, isActive: true, notes: 'Airport and southern/eastern delivery routes.' }
    ]);
  }

  const hoursCount = await db.collection('operating_hours').countDocuments();
  if (!hoursCount) {
    await db.collection('operating_hours').insertMany([
      { weekday: 0, dayName: 'Sunday', opensAt: '12:00', closesAt: '21:30', isOpen: true },
      { weekday: 1, dayName: 'Monday', opensAt: '11:00', closesAt: '22:00', isOpen: true },
      { weekday: 2, dayName: 'Tuesday', opensAt: '11:00', closesAt: '22:00', isOpen: true },
      { weekday: 3, dayName: 'Wednesday', opensAt: '11:00', closesAt: '22:00', isOpen: true },
      { weekday: 4, dayName: 'Thursday', opensAt: '11:00', closesAt: '22:00', isOpen: true },
      { weekday: 5, dayName: 'Friday', opensAt: '11:00', closesAt: '23:00', isOpen: true },
      { weekday: 6, dayName: 'Saturday', opensAt: '11:00', closesAt: '23:00', isOpen: true }
    ]);
  }
}

async function listMenu(res, admin = false) {
  const filter = admin ? {} : { isAvailable: true };
  const items = await db.collection('menu_items').find(filter).sort({ sortOrder: 1, name: 1 }).toArray();
  json(res, 200, { menu: items.map(publicId) });
}

async function listZones(res, admin = false) {
  const filter = admin ? {} : { isActive: true };
  const zones = await db.collection('delivery_zones').find(filter).sort({ district: 1, fee: 1, name: 1 }).toArray();
  json(res, 200, { zones: zones.map(publicId) });
}

async function createOrder(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const customerName = cleanString(body.customerName, 120);
  const customerPhone = cleanString(body.customerPhone, 40);
  const customerWhatsapp = cleanString(body.customerWhatsapp, 40);
  const deliveryAddress = cleanString(body.deliveryAddress, 500);
  const notes = cleanString(body.notes, 500);
  const paymentMethod = cleanString(body.paymentMethod || 'Cash on delivery', 80);
  const zoneObjectId = toObjectId(body.zoneId);
  const rawItems = Array.isArray(body.items) ? body.items : [];

  if (!customerName || !customerPhone || !deliveryAddress || !zoneObjectId || !rawItems.length) {
    json(res, 400, { error: 'Customer name, phone, delivery address, zone, and items are required' });
    return;
  }

  const zone = await db.collection('delivery_zones').findOne({ _id: zoneObjectId, isActive: true });
  if (!zone) {
    json(res, 400, { error: 'Delivery zone is not available' });
    return;
  }

  const groupedItems = new Map();
  for (const item of rawItems) {
    const itemObjectId = toObjectId(item.menuItemId || item.id);
    const quantity = Math.max(1, Math.min(20, Number(item.quantity || 1)));
    if (!itemObjectId) continue;
    const key = itemObjectId.toString();
    groupedItems.set(key, { menuItemId: itemObjectId, quantity: (groupedItems.get(key)?.quantity || 0) + quantity });
  }

  if (!groupedItems.size) {
    json(res, 400, { error: 'No valid menu items were submitted' });
    return;
  }

  const menuIds = [...groupedItems.values()].map(item => item.menuItemId);
  const menuItems = await db.collection('menu_items').find({ _id: { $in: menuIds }, isAvailable: true }).toArray();
  if (menuItems.length !== menuIds.length) {
    json(res, 400, { error: 'One or more menu items are unavailable' });
    return;
  }

  const orderItems = menuItems.map(item => {
    const quantity = groupedItems.get(item._id.toString()).quantity;
    return {
      menuItemId: item._id,
      name: item.name,
      unitPrice: item.price,
      quantity,
      lineTotal: item.price * quantity
    };
  });

  const subtotal = orderItems.reduce((sum, item) => sum + item.lineTotal, 0);
  const total = subtotal + zone.fee;
  const order = {
    orderNumber: buildOrderNumber(),
    customerName,
    customerPhone,
    customerWhatsapp,
    deliveryAddress,
    zoneId: zone._id,
    zoneName: zone.name,
    zoneDistrict: zone.district,
    deliveryFee: zone.fee,
    etaMinutes: zone.etaMinutes,
    subtotal,
    total,
    status: 'Received',
    paymentMethod,
    notes,
    items: orderItems,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  await db.collection('orders').insertOne(order);
  await notifyOrder(order, zone, orderItems);

  json(res, 201, {
    ok: true,
    order: publicId(order),
    message: `Order ${order.orderNumber} received`
  });
}

async function listOrders(res) {
  const orders = await db.collection('orders').find({}).sort({ createdAt: -1 }).toArray();
  json(res, 200, { orders: orders.map(publicId) });
}

async function updateOrderStatus(req, res, id) {
  if (!requireAdmin(req, res)) return;
  let body;
  try {
    body = await readJson(req);
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }
  const orderId = toObjectId(id);
  const allowed = ['Received', 'Preparing', 'Out for delivery', 'Completed', 'Cancelled'];
  const status = cleanString(body.status, 40);
  if (!orderId || !allowed.includes(status)) {
    json(res, 400, { error: 'Valid order id and status are required' });
    return;
  }
  const result = await db.collection('orders').findOneAndUpdate(
    { _id: orderId },
    { $set: { status, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!result) {
    json(res, 404, { error: 'Order not found' });
    return;
  }
  json(res, 200, { ok: true, order: publicId(result) });
}

async function upsertMenuItem(req, res, id = null) {
  if (!requireAdmin(req, res)) return;
  let body;
  try {
    body = await readJson(req);
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }
  const doc = {
    name: cleanString(body.name, 120),
    description: cleanString(body.description, 500),
    category: cleanString(body.category, 80),
    price: Number(body.price || 0),
    imageUrl: cleanString(body.imageUrl, 300),
    rating: Number(body.rating || 4.7),
    badge: cleanString(body.badge, 40),
    isFeatured: Boolean(body.isFeatured),
    isAvailable: body.isAvailable !== false,
    sortOrder: Number(body.sortOrder || 100),
    updatedAt: new Date()
  };
  if (!doc.name || !doc.description || !doc.category || doc.price <= 0 || !doc.imageUrl) {
    json(res, 400, { error: 'Name, description, category, price, and imageUrl are required' });
    return;
  }
  if (id) {
    const objectId = toObjectId(id);
    if (!objectId) return json(res, 400, { error: 'Invalid menu id' });
    const result = await db.collection('menu_items').findOneAndUpdate(
      { _id: objectId },
      { $set: doc },
      { returnDocument: 'after' }
    );
    if (!result) return json(res, 404, { error: 'Menu item not found' });
    return json(res, 200, { ok: true, menuItem: publicId(result) });
  }
  doc.createdAt = new Date();
  await db.collection('menu_items').insertOne(doc);
  json(res, 201, { ok: true, menuItem: publicId(doc) });
}

async function updateHours(req, res) {
  if (!requireAdmin(req, res)) return;
  let body;
  try {
    body = await readJson(req);
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }
  const weekday = Number(body.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    json(res, 400, { error: 'Weekday must be 0-6' });
    return;
  }
  const update = {
    dayName: cleanString(body.dayName, 20),
    opensAt: cleanString(body.opensAt, 5),
    closesAt: cleanString(body.closesAt, 5),
    isOpen: body.isOpen !== false,
    updatedAt: new Date()
  };
  await db.collection('operating_hours').updateOne({ weekday }, { $set: update }, { upsert: true });
  json(res, 200, { ok: true });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, service: 'sacha-backend', database: MONGODB_DB });
  }
  if (req.method === 'GET' && pathname === '/api/status') {
    return json(res, 200, await restaurantStatus());
  }
  if (req.method === 'GET' && pathname === '/api/menu') return listMenu(res);
  if (req.method === 'GET' && pathname === '/api/delivery-zones') return listZones(res);
  if (req.method === 'GET' && pathname === '/api/operating-hours') {
    const hours = await db.collection('operating_hours').find({}).sort({ weekday: 1 }).toArray();
    return json(res, 200, { hours: hours.map(publicId) });
  }
  if (req.method === 'POST' && pathname === '/api/orders') return createOrder(req, res);

  if (req.method === 'GET' && pathname === '/api/admin/orders') {
    if (!requireAdmin(req, res)) return;
    return listOrders(res);
  }
  if (req.method === 'GET' && pathname === '/api/admin/menu') {
    if (!requireAdmin(req, res)) return;
    return listMenu(res, true);
  }
  if (req.method === 'GET' && pathname === '/api/admin/delivery-zones') {
    if (!requireAdmin(req, res)) return;
    return listZones(res, true);
  }
  if (req.method === 'POST' && pathname === '/api/admin/menu') return upsertMenuItem(req, res);
  if (req.method === 'PATCH' && pathname.startsWith('/api/admin/menu/')) {
    return upsertMenuItem(req, res, pathname.split('/').pop());
  }
  if (req.method === 'PATCH' && pathname.startsWith('/api/admin/orders/') && pathname.endsWith('/status')) {
    const id = pathname.split('/').at(-2);
    return updateOrderStatus(req, res, id);
  }
  if (req.method === 'PATCH' && pathname === '/api/admin/operating-hours') return updateHours(req, res);

  return notFound(res);
}

async function main() {
  await client.connect();
  db = client.db(MONGODB_DB);
  await ensureIndexes();
  await seedData();

  const server = http.createServer(async (req, res) => {
    try {
      await handleApi(req, res);
    } catch (error) {
      console.error(error);
      json(res, 500, { error: error.message || 'Server error' });
    }
  });

  server.listen(PORT, () => {
    console.log(`${RESTAURANT_NAME} Mongo backend running at http://127.0.0.1:${PORT}`);
    if (ADMIN_TOKEN === 'sacha-admin-dev') {
      console.log('Using default SACHA_ADMIN_TOKEN. Set a stronger token before publishing.');
    }
  });
}

main().catch(error => {
  console.error('Failed to start Sacha backend:', error);
  process.exit(1);
});
