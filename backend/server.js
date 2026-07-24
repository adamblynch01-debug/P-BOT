require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.options('*', cors());
app.use(express.json());

// ─── Routes ─────────────────────────────────────────────
app.use('/api/orders',   require('./routes/orders'));
app.use('/api/products', require('./routes/products'));
app.use('/api/stock',    require('./routes/stock'));
app.use('/api/config',   require('./routes/config'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/balance',  require('./routes/balance'));
app.use('/api/reviews',  require('./routes/reviews'));
app.use('/api/status',   require('./routes/status'));
app.use('/api/state',    require('./routes/state'));
app.use('/api/reseller', require('./routes/reseller'));

// ─── Health ─────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', store: process.env.STORE_NAME || 'H8ED Shop' }));

// ─── Start ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
require('./routes/config').loadConfigFromDB().finally(() => {
  app.listen(PORT, () => {
    console.log(`[H8ED] Backend running on port ${PORT}`);
    require('./watchers/emailWatcher').start();
    require('./watchers/cryptoWatcher').start();
  });
});
