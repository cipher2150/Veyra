const assert = require('assert');
const http = require('http');
const app = require('../index');

function makeRequest(server, options, postData = null) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const reqOptions = {
      hostname: '127.0.0.1',
      port,
      path: options.path,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    if (postData) {
      const dataStr = typeof postData === 'string' ? postData : JSON.stringify(postData);
      reqOptions.headers['Content-Type'] = 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(dataStr);
    }

    const req = http.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let parsed = body;
        try {
          parsed = JSON.parse(body);
        } catch (e) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsed,
          rawBody: body,
        });
      });
    });

    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function runApiTests() {
  console.log('🧪 Starting SplitLedger API & Idempotency Integration Tests...\n');
  const server = app.listen(0);

  try {
    // 1. Health check
    const health = await makeRequest(server, { path: '/api/health' });
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.data.status, 'ok');
    console.log('✅ 1. Health check passed.');

    // 2. Register User 1 (Rohan)
    const email1 = `rohan_${Date.now()}@example.com`;
    const reg1 = await makeRequest(server, { path: '/api/auth/register', method: 'POST' }, {
      name: 'Rohan Sharma',
      email: email1,
      password: 'password123',
    });
    assert.strictEqual(reg1.status, 201);
    const token1 = reg1.data.token;
    const user1 = reg1.data.user;
    console.log('✅ 2. User 1 registered with JWT token.');

    // 3. Register User 2 (Priya)
    const email2 = `priya_${Date.now()}@example.com`;
    const reg2 = await makeRequest(server, { path: '/api/auth/register', method: 'POST' }, {
      name: 'Priya Patel',
      email: email2,
      password: 'password123',
    });
    assert.strictEqual(reg2.status, 201);
    const user2 = reg2.data.user;
    console.log('✅ 3. User 2 registered.');

    // 4. Create Group
    const groupRes = await makeRequest(server, {
      path: '/api/groups',
      method: 'POST',
      headers: { Authorization: `Bearer ${token1}` },
    }, {
      name: 'Goa Trip 2026',
      type: 'trip',
    });
    assert.strictEqual(groupRes.status, 201);
    const groupId = groupRes.data.id;
    console.log(`✅ 4. Group created (ID: ${groupId}).`);

    // 5. Add User 2 to Group
    const addMemberRes = await makeRequest(server, {
      path: `/api/groups/${groupId}/members`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token1}` },
    }, {
      userId: user2.id,
    });
    assert.strictEqual(addMemberRes.status, 201);
    console.log('✅ 5. Member added to group.');

    // 6. Record Expense (₹500 split equally)
    const expRes = await makeRequest(server, {
      path: '/api/expenses',
      method: 'POST',
      headers: { Authorization: `Bearer ${token1}` },
    }, {
      groupId,
      description: 'Dinner at Beach Shack',
      amount: '500.00',
      splitType: 'EQUAL',
      paidByUserId: user1.id,
      participants: [user1.id, user2.id],
    });
    assert.strictEqual(expRes.status, 201);
    const expenseId = expRes.data.id;
    console.log(`✅ 6. Expense recorded (ID: ${expenseId}). Total ₹500.00.`);

    // 7. Check Group Balances
    const balRes = await makeRequest(server, {
      path: `/api/balances/group/${groupId}`,
      headers: { Authorization: `Bearer ${token1}` },
    });
    assert.strictEqual(balRes.status, 200);
    // Rohan paid 500, consumed 250 -> net +250
    assert.strictEqual(balRes.data.user.netRupees, '250.00');
    // Priya owes 250
    assert.strictEqual(balRes.data.simplified.all[0].amountRupees, '250.00');
    console.log('✅ 7. Balances & Debt simplification validated.');

    // 8. Test Idempotent Settlement:
    // Request with Idempotency-Key
    const idemKey = `idem_${Date.now()}_abc`;
    const settlePayload = {
      groupId,
      fromUserId: user2.id,
      toUserId: user1.id,
      amount: '250.00',
      notes: 'Priya settled dinner share',
    };

    // First call (creates payment)
    const settle1 = await makeRequest(server, {
      path: '/api/settlements',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token1}`,
        'Idempotency-Key': idemKey,
      },
    }, settlePayload);
    assert.strictEqual(settle1.status, 201);
    assert.strictEqual(settle1.headers['x-cache-lookup'], 'MISS-IDEMPOTENT');
    const settleTxId = settle1.data.transaction.id;
    console.log(`✅ 8a. Idempotent settlement created (Tx ID: ${settleTxId}).`);

    // Second call with SAME Idempotency-Key (simulating network retry or double-click)
    const settle2 = await makeRequest(server, {
      path: '/api/settlements',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token1}`,
        'Idempotency-Key': idemKey,
      },
    }, settlePayload);
    assert.strictEqual(settle2.status, 201);
    assert.strictEqual(settle2.headers['x-cache-lookup'], 'HIT-IDEMPOTENT');
    assert.strictEqual(settle2.data.transaction.id, settleTxId, 'Must return identical cached transaction without creating a duplicate!');
    console.log('✅ 8b. Idempotency verified! Second request returned cached response with HIT-IDEMPOTENT.');

    // Check balance is now 0 for both users
    const balAfter = await makeRequest(server, {
      path: `/api/balances/group/${groupId}`,
      headers: { Authorization: `Bearer ${token1}` },
    });
    assert.strictEqual(balAfter.data.user.netRupees, '0.00');
    assert.strictEqual(balAfter.data.simplified.all.length, 0, 'All debts completely settled');
    console.log('✅ 8c. Group balance is perfectly ₹0.00 after settlement.');

    // 9. Test CSV Export
    const csvRes = await makeRequest(server, {
      path: `/api/export/csv?groupId=${groupId}`,
      headers: { Authorization: `Bearer ${token1}` },
    });
    assert.strictEqual(csvRes.status, 200);
    assert(csvRes.headers['content-type'].includes('text/csv'));
    assert(csvRes.rawBody.includes('Dinner at Beach Shack'));
    assert(csvRes.rawBody.includes('500.00'));
    console.log('✅ 9. CSV export validated.');

    // 10. Test Paginated & Filterable Transaction History
    const historyRes = await makeRequest(server, {
      path: `/api/transactions?groupId=${groupId}&limit=10&page=1`,
      headers: { Authorization: `Bearer ${token1}` },
    });
    assert.strictEqual(historyRes.status, 200);
    assert.strictEqual(historyRes.data.transactions.length, 2); // 1 expense + 1 settlement
    console.log('✅ 10. Paginated filterable transaction history validated.');

    // 11. Test Group Activity Logs
    const actRes = await makeRequest(server, {
      path: `/api/groups/${groupId}/activity`,
      headers: { Authorization: `Bearer ${token1}` },
    });
    assert.strictEqual(actRes.status, 200);
    assert(actRes.data.length >= 4); // created, member added, expense, settlement
    console.log('✅ 11. Group activity logs validated.');

    console.log('\n🎉 ALL 11 API INTEGRATION & IDEMPOTENCY TESTS PASSED!\n');
  } finally {
    server.close();
  }
}

runApiTests().catch(err => {
  console.error('API Test Error:', err);
  process.exit(1);
});
