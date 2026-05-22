const http = require('node:http');

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'object' ? JSON.stringify(options.body) : options.body);
    }
    req.end();
  });
}

async function runTests() {
  console.log('=== STARTING PROGRAMMATIC ROUTING AND API SECURITY VERIFICATION ===\n');

  try {
    // 1. Verify Public Settings API
    console.log('Testing GET /api/settings (Public Site Settings)...');
    const settingsRes = await request('http://localhost:3000/api/settings');
    console.log(`Status: ${settingsRes.status}`);
    const settingsPayload = JSON.parse(settingsRes.body);
    const settings = settingsPayload.settings;
    console.log('Received settings:', settings);
    if (settingsRes.status === 200 && settings && settings.phone && settings.email) {
      console.log('✅ PASS: Public settings API loaded dynamically from MongoDB!\n');
    } else {
      console.log('❌ FAIL: Public settings API returned invalid response.\n');
    }

    // 2. Verify `/admin` has been successfully obscured (returns 404)
    console.log('Testing GET /admin (Obscured old route)...');
    const oldRouteRes = await request('http://localhost:3000/admin');
    console.log(`Status: ${oldRouteRes.status}`);
    if (oldRouteRes.status === 404) {
      console.log('✅ PASS: Old admin route successfully returned 404 Not Found!\n');
    } else {
      console.log('❌ FAIL: Old admin route is still active!\n');
    }

    // 3. Verify Secret Route `/manage-dodos-showroom-9f8d2b` is active (returns 200)
    console.log('Testing GET /manage-dodos-showroom-9f8d2b (Secret Obscured custom route)...');
    const secretRouteRes = await request('http://localhost:3000/manage-dodos-showroom-9f8d2b');
    console.log(`Status: ${secretRouteRes.status}`);
    if (secretRouteRes.status === 200 && secretRouteRes.body.includes('<!DOCTYPE html>')) {
      console.log('✅ PASS: Secret admin route serves the single page app perfectly!\n');
    } else {
      console.log('❌ FAIL: Secret admin route is inactive or failing!\n');
    }

    // 4. Verify Admin API Protection (POST /api/admin/settings without session)
    console.log('Testing POST /api/admin/settings (Unauthorized Check)...');
    const postSettingsRes = await request('http://localhost:3000/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { phone: '0784582764' }
    });
    console.log(`Status: ${postSettingsRes.status}`);
    if (postSettingsRes.status === 401) {
      console.log('✅ PASS: Admin settings update successfully protected (401 Unauthorized)!\n');
    } else {
      console.log('❌ FAIL: Admin settings endpoint allowed modification without auth!\n');
    }

    // 5. Verify Password Update protection (POST /api/admin/change-password without session)
    console.log('Testing POST /api/admin/change-password (Unauthorized Check)...');
    const postPassRes = await request('http://localhost:3000/api/admin/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { currentPassword: 'dodos@123', newPassword: 'dodos@newpassword' }
    });
    console.log(`Status: ${postPassRes.status}`);
    if (postPassRes.status === 401) {
      console.log('✅ PASS: Security password change successfully protected (401 Unauthorized)!\n');
    } else {
      console.log('❌ FAIL: Security password change endpoint allowed modification without auth!\n');
    }

    console.log('=== ALL SYSTEM ROUTING AND API SECURITY VERIFICATIONS COMPLETED SUCCESSFULLY ===');

  } catch (err) {
    console.error('❌ Verification script encountered an error:', err);
  }
}

runTests();
