require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Railway terminates TLS at its edge and forwards to us over plain HTTP, so
// req.ip is the proxy's address unless we trust the X-Forwarded-For header.
// The rate limiters in utils/rateLimit.js key on req.ip — without this every
// visitor collapses into one bucket and the per-IP limits would lock out real
// customers the moment anyone hit them. '1' = trust exactly one proxy hop
// (Railway's), so a client-supplied X-Forwarded-For can't spoof its way past
// the limiter by prepending fake entries.
app.set('trust proxy', 1);

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
