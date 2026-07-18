require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Supabase ───────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── Routes ─────────────────────────────────────────────
app.use('/api/orders',   require('./routes/orders'));
app.use('/api/products', require('./routes/products'));
app.use('/api/stock',    require('./routes/stock'));
app.use('/api/config',   require('./routes/config'));
app.use('/api/webhooks', require('./routes/webhooks'));

// ─── Health ─────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', store: process.env.STORE_NAME }));

// ─── Start ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[H8ED] Backend running on port ${PORT}`);
  require('./watchers/emailWatcher').start();
  require('./watchers/cryptoWatcher').start();
});

module.exports = { supabase };
