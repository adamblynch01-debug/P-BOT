/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GENERATOR API ROUTES - P-BOT
 * Complete account & SMS generator backend
 * ═══════════════════════════════════════════════════════════════════════════
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');

// ─────────────────────────────────────────────────────────────────────────────
// CHECK GENERATOR ACCESS
// ─────────────────────────────────────────────────────────────────────────────

router.post('/check-access', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.json({ hasAccess: false, error: 'No user ID' });
    }

    // Check for active subscription
    const subResult = await db.query(`
      SELECT * FROM generator_subscriptions
      WHERE user_id = $1 AND expires_at > NOW() AND active = true
      ORDER BY expires_at DESC LIMIT 1
    `, [userId]);

    if (subResult.rows.length > 0) {
      return res.json({
        hasAccess: true,
        type: 'subscription',
        expiresAt: subResult.rows[0].expires_at
      });
    }

    // Check for available credits
    const creditResult = await db.query(`
      SELECT COUNT(*) as count FROM generator_credits
      WHERE user_id = $1 AND used = false
    `, [userId]);

    const creditCount = parseInt(creditResult.rows[0].count);

    if (creditCount > 0) {
      return res.json({
        hasAccess: true,
        type: 'credit',
        remaining: creditCount
      });
    }

    return res.json({ hasAccess: false });

  } catch (error) {
    console.error('[GENERATOR] Access check error:', error);
    res.json({ hasAccess: false, error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PURCHASE ACCESS
// ─────────────────────────────────────────────────────────────────────────────

router.post('/purchase-access', async (req, res) => {
  try {
    const { userId, type } = req.body;

    if (!userId || !type) {
      return res.json({ success: false, error: 'Missing parameters' });
    }

    if (type === 'subscription') {
      // Create monthly subscription
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1);

      await db.query(`
        INSERT INTO generator_subscriptions (user_id, expires_at, active)
        VALUES ($1, $2, true)
      `, [userId, expiresAt]);

      // TODO: Integrate with payment processor (Stripe/PayPal)

      return res.json({ success: true, type: 'subscription', expiresAt });

    } else if (type === 'credit') {
      // Add single credit
      await db.query(`
        INSERT INTO generator_credits (user_id, used)
        VALUES ($1, false)
      `, [userId]);

      // TODO: Integrate with payment processor

      return res.json({ success: true, type: 'credit', remaining: 1 });
    }

    res.json({ success: false, error: 'Invalid type' });

  } catch (error) {
    console.error('[GENERATOR] Purchase error:', error);
    res.json({ success: false, error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────

router.post('/account', async (req, res) => {
  try {
    const { type, userId } = req.body;

    if (!type) {
      return res.json({ success: false, error: 'Missing type' });
    }

    // Check if stock exists
    const stockResult = await db.query(`
      SELECT * FROM generator_stock
      WHERE type = $1 AND claimed = false
      LIMIT 1
    `, [type]);

    if (stockResult.rows.length === 0) {
      return res.json({ success: false, error: 'Out of stock' });
    }

    const account = stockResult.rows[0];

    // Mark as claimed
    await db.query(`
      UPDATE generator_stock
      SET claimed = true, claimed_by = $1, claimed_at = NOW()
      WHERE id = $2
    `, [userId, account.id]);

    // Use credit if applicable
    if (userId) {
      await db.query(`
        UPDATE generator_credits
        SET used = true, used_at = NOW()
        WHERE user_id = $1 AND used = false
        ORDER BY created_at ASC LIMIT 1
      `, [userId]);
    }

    // Log generation
    await db.query(`
      INSERT INTO generator_logs (user_id, type, account_email, status)
      VALUES ($1, $2, $3, 'success')
    `, [userId, type, account.email]);

    res.json({
      success: true,
      account: {
        email: account.email,
        username: account.username,
        password: account.password,
        extra: account.extra
      }
    });

  } catch (error) {
    console.error('[GENERATOR] Account generation error:', error);
    res.json({ success: false, error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SMS GENERATOR - 5SIM
// ─────────────────────────────────────────────────────────────────────────────

const FIVESIM_API_KEY = process.env.FIVESIM_API_KEY || '';
const FIVESIM_BASE = 'https://5sim.net/v1';

router.get('/sms/fivesim/services', async (req, res) => {
  try {
    const response = await axios.get(`${FIVESIM_BASE}/guest/products/usa/any`);
    const data = response.data;

    const services = Object.keys(data).map(key => ({
      value: key,
      label: key.charAt(0).toUpperCase() + key.slice(1)
    }));

    res.json({ success: true, services });
  } catch (error) {
    console.error('[5SIM] Services error:', error);
    res.json({ success: false, error: 'Failed to load services' });
  }
});

router.get('/sms/fivesim/countries', async (req, res) => {
  try {
    const { service } = req.query;

    const response = await axios.get(`${FIVESIM_BASE}/guest/countries`);
    const data = response.data;

    const countries = Object.keys(data).map(code => ({
      code: code,
      name: data[code].text_en,
      price: '$0.50'
    }));

    res.json({ success: true, countries });
  } catch (error) {
    console.error('[5SIM] Countries error:', error);
    res.json({ success: false, error: 'Failed to load countries' });
  }
});

router.post('/sms/fivesim/purchase', async (req, res) => {
  try {
    const { service, country, userId } = req.body;

    const response = await axios.get(
      `${FIVESIM_BASE}/user/buy/activation/${country}/any/${service}`,
      {
        headers: {
          'Authorization': `Bearer ${FIVESIM_API_KEY}`,
          'Accept': 'application/json'
        }
      }
    );

    const data = response.data;

    if (data.id && data.phone) {
      // Save order to database
      await db.query(`
        INSERT INTO sms_orders (order_id, provider, service_name, country, number, user_id, channel_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [data.id, 'fivesim', service, country, data.phone, userId, null]);

      res.json({
        success: true,
        order: {
          id: data.id,
          number: data.phone,
          provider: 'fivesim'
        }
      });
    } else {
      console.error('[5SIM] Purchase failed - invalid response:', data);
      res.json({ success: false, error: 'Purchase failed', details: data });
    }
  } catch (error) {
    console.error('[5SIM] Purchase error:', error.response?.data || error.message);
    res.json({ success: false, error: 'Purchase failed', details: error.response?.data || error.message });
  }
});

router.get('/sms/fivesim/check/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    const response = await axios.get(`${FIVESIM_BASE}/user/check/${orderId}`, {
      headers: {
        'Authorization': `Bearer ${FIVESIM_API_KEY}`,
        'Accept': 'application/json'
      }
    });

    const data = response.data;

    if (data.sms && data.sms.length > 0) {
      const code = data.sms[0].code;

      // Update database
      await db.query(`
        UPDATE sms_orders SET code = $1, completed = true WHERE order_id = $2
      `, [code, orderId]);

      res.json({ success: true, code });
    } else {
      res.json({ success: true, code: null });
    }
  } catch (error) {
    console.error('[5SIM] Check error:', error);
    res.json({ success: false });
  }
});

router.post('/sms/fivesim/cancel/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    await axios.get(`${FIVESIM_BASE}/user/cancel/${orderId}`, {
      headers: {
        'Authorization': `Bearer ${FIVESIM_API_KEY}`,
        'Accept': 'application/json'
      }
    });

    await db.query(`UPDATE sms_orders SET cancelled = true WHERE order_id = $1`, [orderId]);

    res.json({ success: true });
  } catch (error) {
    console.error('[5SIM] Cancel error:', error);
    res.json({ success: false });
  }
});

router.post('/sms/fivesim/resend/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    await axios.get(`${FIVESIM_BASE}/user/finish/${orderId}`, {
      headers: {
        'Authorization': `Bearer ${FIVESIM_API_KEY}`,
        'Accept': 'application/json'
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[5SIM] Resend error:', error);
    res.json({ success: false });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SMS GENERATOR - SMSPOOL
// ─────────────────────────────────────────────────────────────────────────────

const SMSPOOL_API_KEY = process.env.SMSPOOL_API_KEY || '';
const SMSPOOL_BASE = 'https://api.smspool.net';

router.get('/sms/smspool/services', async (req, res) => {
  try {
    const params = new URLSearchParams({ key: SMSPOOL_API_KEY });

    const response = await axios.get(`${SMSPOOL_BASE}/service/retrieve_all`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    const data = response.data;

    const services = Object.keys(data).map(key => ({
      value: key,
      label: data[key].name || key
    }));

    res.json({ success: true, services });
  } catch (error) {
    console.error('[SMSPOOL] Services error:', error);
    res.json({ success: false, error: 'Failed to load services' });
  }
});

router.get('/sms/smspool/countries', async (req, res) => {
  try {
    const { service } = req.query;
    const params = new URLSearchParams({ key: SMSPOOL_API_KEY });

    const response = await axios.get(`${SMSPOOL_BASE}/country/retrieve_all`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    const data = response.data;

    const countries = Object.keys(data).map(code => ({
      code: code,
      name: data[code].name,
      price: '$0.50'
    }));

    res.json({ success: true, countries });
  } catch (error) {
    console.error('[SMSPOOL] Countries error:', error);
    res.json({ success: false, error: 'Failed to load countries' });
  }
});

router.post('/sms/smspool/purchase', async (req, res) => {
  try {
    const { service, country, userId } = req.body;

    const params = new URLSearchParams({
      key: SMSPOOL_API_KEY,
      country: country,
      service: service
    });

    const response = await axios.post(`${SMSPOOL_BASE}/purchase/sms`, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const data = response.data;

    if (data.success && data.number) {
      await db.query(`
        INSERT INTO sms_orders (order_id, provider, service_name, country, number, user_id, channel_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [data.order_id, 'smspool', service, country, data.number, userId, null]);

      res.json({
        success: true,
        order: {
          id: data.order_id,
          number: data.number,
          provider: 'smspool'
        }
      });
    } else {
      console.error('[SMSPOOL] Purchase failed - invalid response:', data);
      res.json({ success: false, error: 'Purchase failed', details: data });
    }
  } catch (error) {
    console.error('[SMSPOOL] Purchase error:', error.response?.data || error.message);
    res.json({ success: false, error: 'Purchase failed', details: error.response?.data || error.message });
  }
});

router.get('/sms/smspool/check/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    const response = await axios.get(
      `${SMSPOOL_BASE}/sms/check?key=${SMSPOOL_API_KEY}&orderid=${orderId}`
    );

    const data = response.data;

    if (data.status === 3 && data.sms) {
      await db.query(`
        UPDATE sms_orders SET code = $1, completed = true WHERE order_id = $2
      `, [data.sms, orderId]);

      res.json({ success: true, code: data.sms });
    } else {
      res.json({ success: true, code: null });
    }
  } catch (error) {
    console.error('[SMSPOOL] Check error:', error);
    res.json({ success: false });
  }
});

router.post('/sms/smspool/cancel/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    await axios.get(`${SMSPOOL_BASE}/sms/cancel?key=${SMSPOOL_API_KEY}&orderid=${orderId}`, {
    });

    await db.query(`UPDATE sms_orders SET cancelled = true WHERE order_id = $1`, [orderId]);

    res.json({ success: true });
  } catch (error) {
    console.error('[SMSPOOL] Cancel error:', error);
    res.json({ success: false });
  }
});

router.post('/sms/smspool/resend/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    await axios.get(`${SMSPOOL_BASE}/sms/resend?key=${SMSPOOL_API_KEY}&orderid=${orderId}`, {
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[SMSPOOL] Resend error:', error);
    res.json({ success: false });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN - ADD STOCK
// ─────────────────────────────────────────────────────────────────────────────

router.post('/admin/add-stock', async (req, res) => {
  try {
    const { type, accounts } = req.body;

    if (!type || !accounts || !Array.isArray(accounts)) {
      return res.json({ success: false, error: 'Invalid parameters' });
    }

    let added = 0;

    for (const account of accounts) {
      await db.query(`
        INSERT INTO generator_stock (type, email, username, password, extra, claimed)
        VALUES ($1, $2, $3, $4, $5, false)
      `, [type, account.email, account.username || account.email, account.password, account.extra || null]);
      added++;
    }

    res.json({ success: true, added });

  } catch (error) {
    console.error('[ADMIN] Add stock error:', error);
    res.json({ success: false, error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN - GET STOCK
// ─────────────────────────────────────────────────────────────────────────────

router.get('/admin/generator-stock', async (req, res) => {
  try {
    const stockResult = await db.query(`
      SELECT type, COUNT(*) as count
      FROM generator_stock
      WHERE claimed = false
      GROUP BY type
    `);

    const stock = {};
    stockResult.rows.forEach(row => {
      stock[row.type] = { count: parseInt(row.count) };
    });

    const logsResult = await db.query(`
      SELECT * FROM generator_logs
      ORDER BY created_at DESC
      LIMIT 50
    `);

    res.json({ success: true, stock, logs: logsResult.rows });

  } catch (error) {
    console.error('[ADMIN] Get stock error:', error);
    res.json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
