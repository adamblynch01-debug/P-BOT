// ─── H8ED Shop Checkout Integration ─────────────────────
// Drop this script into your existing website
// Set BACKEND_URL to your Railway backend URL

const BACKEND_URL = 'https://YOUR-BACKEND.railway.app'; // ← update this

// ─── Create Order ────────────────────────────────────────
async function createOrder(items, email, discordId, paymentMethod) {
  const res = await fetch(`${BACKEND_URL}/api/orders/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items,
      email,
      discord_id: discordId || null,
      payment_method: paymentMethod,
    }),
  });

  if (!res.ok) throw new Error('Failed to create order');
  return await res.json();
}

// ─── Poll Order Status ───────────────────────────────────
async function pollOrderStatus(orderId, onUpdate) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/orders/${orderId}`);
      const order = await res.json();
      onUpdate(order);

      if (order.status === 'delivered' || order.status === 'paid') {
        clearInterval(interval);
      }
    } catch (err) {
      console.error('Poll error:', err);
    }
  }, 5000); // Poll every 5 seconds

  return interval;
}

// ─── Load Config from Backend ────────────────────────────
async function loadStoreConfig() {
  const res = await fetch(`${BACKEND_URL}/api/config`);
  return await res.json();
}

// ─── Render Payment Page (like Q Services screenshot) ────
async function renderPaymentPage(container, orderData) {
  const { payment_method, payment_info, total, order_id, expires_at, fee_note } = orderData;

  let paymentHTML = '';

  if (payment_method === 'cashapp') {
    const cashtagUrl = `https://cash.app/${payment_info.cashtag}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(cashtagUrl)}`;
    paymentHTML = `
      <div class="payment-logo cashapp-logo">
        <img src="https://upload.wikimedia.org/wikipedia/commons/c/c5/Square_Cash_app_logo.svg" width="40" alt="Cash App">
        <span>Cash App Payment</span>
        <span class="payment-amount">$${total}</span>
      </div>
      <img src="${qrUrl}" class="qr-code" alt="QR Code">
      <div class="copy-field">
        <span>Cashtag:</span>
        <strong>${payment_info.cashtag}</strong>
        <button onclick="copyText('${payment_info.cashtag}')">Copy</button>
      </div>
      <a href="${cashtagUrl}" target="_blank" class="open-app-btn">Open Cash App ↗</a>
      <div class="warning-box">
        ⚠️ ADD THE NOTE BELOW TO THE PAYMENT, OTHERWISE IT WILL BE IGNORED.
        <p>Make sure to add the note, otherwise your order won't be automatically processed.</p>
      </div>
      <div class="copy-field note-field">
        <span>Note:</span>
        <strong id="payment-note">${payment_info.note}</strong>
        <button onclick="copyText('${payment_info.note}')">Copy</button>
      </div>
      <div class="exact-amount">
        MAKE SURE TO SEND THE EXACT AMOUNT
        <span class="copy-field">$${total} <button onclick="copyText('${total}')">Copy</button></span>
      </div>
      <div class="how-to-pay">
        <h4>HOW TO PAY</h4>
        <ol>
          <li>Open Cash App on your phone</li>
          <li>Scan the QR code or send to ${payment_info.cashtag}</li>
          <li>Add the payment note shown above</li>
          <li>Complete the payment. Your order updates automatically.</li>
        </ol>
      </div>
    `;
  } else if (payment_method === 'paypal') {
    const paypalUrl = `https://www.paypal.com/paypalme/${payment_info.email}/${total}`;
    paymentHTML = `
      <div class="payment-logo paypal-logo">
        <img src="https://upload.wikimedia.org/wikipedia/commons/b/b5/PayPal.svg" width="60" alt="PayPal">
        <span>PayPal Payment</span>
        <span class="payment-amount">$${total}</span>
      </div>
      <div class="copy-field">
        <span>Email:</span>
        <strong>${payment_info.email}</strong>
        <button onclick="copyText('${payment_info.email}')">Copy</button>
      </div>
      <a href="https://www.paypal.com/myaccount/transfer/homepage/pay" target="_blank" class="open-app-btn">Open PayPal ↗</a>
      <div class="warning-box">
        ⚠️ ADD THE NOTE TO THE PAYMENT, OTHERWISE IT WILL BE IGNORED.
        <p>Make sure to send as Friends & Family and add the note.</p>
      </div>
      <div class="copy-field note-field">
        <span>Note:</span>
        <strong>${payment_info.note}</strong>
        <button onclick="copyText('${payment_info.note}')">Copy</button>
      </div>
      <div class="exact-amount">
        MAKE SURE TO SEND THE EXACT AMOUNT
        <span class="copy-field">$${total} <button onclick="copyText('${total}')">Copy</button></span>
      </div>
      <div class="how-to-pay">
        <h4>HOW TO PAY</h4>
        <ol>
          <li>Log in to your PayPal account</li>
          <li>Select "Send & Request" then "Send"</li>
          <li>Enter the email address shown above</li>
          <li>Select "Sending to a friend" (Friends & Family)</li>
          <li>Enter the exact amount: $${total}</li>
          <li>Add the Note shown above in the "What's this for?" field</li>
          <li>Complete the payment. Your order updates automatically.</li>
        </ol>
      </div>
    `;
  } else if (payment_method === 'btc' || payment_method === 'ltc') {
    const coin = payment_method.toUpperCase();
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(payment_info.address)}`;
    paymentHTML = `
      <div class="payment-logo crypto-logo">
        <span>${coin === 'BTC' ? '₿' : 'Ł'}</span>
        <span>${coin} Payment</span>
        <span class="payment-amount">$${total}</span>
      </div>
      <img src="${qrUrl}" class="qr-code" alt="QR Code">
      <div class="copy-field">
        <span>Address:</span>
        <strong class="mono">${payment_info.address}</strong>
        <button onclick="copyText('${payment_info.address}')">Copy</button>
      </div>
      <div class="exact-amount">
        MAKE SURE TO SEND THE EXACT AMOUNT IN ${coin}
        <span class="copy-field">$${total} <button onclick="copyText('${total}')">Copy</button></span>
      </div>
      <div class="how-to-pay">
        <h4>HOW TO PAY</h4>
        <ol>
          <li>Open your ${coin} wallet</li>
          <li>Scan the QR code or copy the address above</li>
          <li>Send the exact ${coin} equivalent of $${total}</li>
          <li>Your order will confirm automatically after 1 confirmation.</li>
        </ol>
      </div>
    `;
  }

  const expiresDate = new Date(expires_at);
  const createdDate = new Date();

  container.innerHTML = `
    <div class="h8ed-payment-page">
      ${paymentHTML}
      <div class="waiting-indicator">
        <span class="dot"></span> Waiting for payment. This page updates automatically.
      </div>
      <div class="order-info">
        <h4>ORDER INFORMATION</h4>
        <div class="info-row"><span>Invoice ID</span><span class="mono">${order_id}</span></div>
        <div class="info-row"><span>Payment Method</span><span>${payment_method.toUpperCase()}</span></div>
        <div class="info-row"><span>Total Price</span><span>$${total} ${fee_note ? `(${fee_note})` : ''}</span></div>
        <div class="info-row"><span>Created</span><span>${createdDate.toLocaleString()}</span></div>
        <div class="info-row"><span>Expires</span><span>${expiresDate.toLocaleString()}</span></div>
      </div>
    </div>
  `;

  // Start polling
  pollOrderStatus(order_id, (order) => {
    const dot = container.querySelector('.dot');
    const indicator = container.querySelector('.waiting-indicator');

    if (order.status === 'paid') {
      if (dot) dot.style.backgroundColor = '#ffaa00';
      if (indicator) indicator.textContent = '💰 Payment received! Preparing delivery...';
    }
    if (order.status === 'delivered') {
      if (indicator) indicator.innerHTML = '✅ Order delivered! Check your Discord DM or email.';
      if (dot) dot.remove();
    }
  });
}

// ─── Helper ──────────────────────────────────────────────
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    const btn = event.target;
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 1500);
  });
}

// ─── Checkout Modal / Flow ───────────────────────────────
async function openCheckout(cart) {
  const config = await loadStoreConfig();

  const modal = document.createElement('div');
  modal.id = 'h8ed-checkout-modal';
  modal.innerHTML = `
    <div class="checkout-overlay" onclick="closeCheckout()"></div>
    <div class="checkout-modal">
      <button class="close-btn" onclick="closeCheckout()">✕</button>

      <div id="checkout-step-1">
        <h2>Checkout</h2>
        <div class="order-summary">
          <h3>ORDER SUMMARY</h3>
          ${cart.map(i => `<div class="cart-item"><span>${i.name} x${i.qty}</span><span>$${(i.price * i.qty).toFixed(2)}</span></div>`).join('')}
          <div class="cart-total">Total: $${cart.reduce((s,i) => s + i.price * i.qty, 0).toFixed(2)}</div>
        </div>

        <div class="checkout-fields">
          <h3>CONTACT & DELIVERY</h3>
          <input type="email" id="checkout-email" placeholder="E-mail Address *" required>
          <input type="text" id="checkout-discord" placeholder="Discord ID (optional — for DM delivery)">

          <h3>PAYMENT</h3>
          <div class="payment-methods">
            ${config.payment_methods.cashapp ? `
              <label class="payment-option">
                <input type="radio" name="payment" value="cashapp">
                <img src="https://upload.wikimedia.org/wikipedia/commons/c/c5/Square_Cash_app_logo.svg" width="24">
                Cash App <span class="fee">+${config.cashapp_fee}%</span>
              </label>` : ''}
            ${config.payment_methods.btc ? `
              <label class="payment-option">
                <input type="radio" name="payment" value="btc">
                <span class="coin-icon">₿</span>
                Bitcoin <span class="discount">-${config.crypto_discount}%</span>
              </label>` : ''}
            ${config.payment_methods.ltc ? `
              <label class="payment-option">
                <input type="radio" name="payment" value="ltc">
                <span class="coin-icon">Ł</span>
                Litecoin <span class="discount">-${config.crypto_discount}%</span>
              </label>` : ''}
            ${config.payment_methods.paypal ? `
              <label class="payment-option">
                <input type="radio" name="payment" value="paypal">
                <img src="https://upload.wikimedia.org/wikipedia/commons/b/b5/PayPal.svg" width="40">
                PayPal F&F <span class="fee">+${config.paypal_fee || 10}%</span>
              </label>` : ''}
          </div>
        </div>

        <label class="tos-check">
          <input type="checkbox" id="checkout-tos">
          I have read and agree to H8ED's Terms of Service.
        </label>

        <button class="proceed-btn" onclick="proceedToPayment()">Proceed to Payment →</button>
        <div id="checkout-error" class="error-msg"></div>
      </div>

      <div id="checkout-step-2" style="display:none">
        <div id="payment-container"></div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  injectCheckoutStyles();
}

async function proceedToPayment() {
  const email = document.getElementById('checkout-email').value.trim();
  const discordId = document.getElementById('checkout-discord').value.trim();
  const paymentMethod = document.querySelector('input[name="payment"]:checked')?.value;
  const tos = document.getElementById('checkout-tos').checked;
  const errorEl = document.getElementById('checkout-error');

  if (!email) return (errorEl.textContent = 'Email is required.');
  if (!paymentMethod) return (errorEl.textContent = 'Select a payment method.');
  if (!tos) return (errorEl.textContent = 'Please agree to the Terms of Service.');

  const btn = document.querySelector('.proceed-btn');
  btn.textContent = 'Creating order...';
  btn.disabled = true;
  errorEl.textContent = '';

  try {
    const cart = window._h8edCart || [];
    const orderData = await createOrder(cart, email, discordId, paymentMethod);

    document.getElementById('checkout-step-1').style.display = 'none';
    document.getElementById('checkout-step-2').style.display = 'block';

    const container = document.getElementById('payment-container');
    await renderPaymentPage(container, orderData);
  } catch (err) {
    errorEl.textContent = 'Failed to create order. Try again.';
    btn.textContent = 'Proceed to Payment →';
    btn.disabled = false;
  }
}

function closeCheckout() {
  document.getElementById('h8ed-checkout-modal')?.remove();
}

// ─── Inject Styles ───────────────────────────────────────
function injectCheckoutStyles() {
  if (document.getElementById('h8ed-checkout-styles')) return;
  const style = document.createElement('style');
  style.id = 'h8ed-checkout-styles';
  style.textContent = `
    #h8ed-checkout-modal { position:fixed; inset:0; z-index:9999; display:flex; align-items:center; justify-content:center; }
    .checkout-overlay { position:absolute; inset:0; background:rgba(0,0,0,0.85); }
    .checkout-modal { position:relative; background:#111; color:#fff; border-radius:12px; padding:24px; width:90%; max-width:480px; max-height:90vh; overflow-y:auto; z-index:1; }
    .close-btn { position:absolute; top:12px; right:16px; background:none; border:none; color:#fff; font-size:20px; cursor:pointer; }
    .checkout-modal h2 { margin:0 0 16px; font-size:22px; }
    .checkout-modal h3 { font-size:11px; letter-spacing:1px; color:#888; margin:16px 0 8px; }
    .cart-item { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #222; }
    .cart-total { display:flex; justify-content:space-between; padding:10px 0 0; font-weight:bold; font-size:18px; }
    .checkout-fields input[type="email"], .checkout-fields input[type="text"] {
      width:100%; padding:12px; background:#1a1a1a; border:1px solid #333; border-radius:8px; color:#fff; margin-bottom:8px; box-sizing:border-box;
    }
    .payment-methods { display:flex; flex-direction:column; gap:8px; }
    .payment-option { display:flex; align-items:center; gap:10px; padding:12px; background:#1a1a1a; border:2px solid #333; border-radius:8px; cursor:pointer; }
    .payment-option:has(input:checked) { border-color:#ff0000; background:#1a0000; }
    .payment-option input { display:none; }
    .coin-icon { width:24px; height:24px; display:flex; align-items:center; justify-content:center; font-weight:bold; }
    .fee { margin-left:auto; background:#333; padding:2px 8px; border-radius:12px; font-size:12px; }
    .discount { margin-left:auto; background:#003300; color:#00ff00; padding:2px 8px; border-radius:12px; font-size:12px; }
    .tos-check { display:flex; align-items:center; gap:8px; margin:16px 0; font-size:13px; cursor:pointer; }
    .proceed-btn { width:100%; padding:14px; background:#ff0000; color:#fff; border:none; border-radius:8px; font-size:16px; font-weight:bold; cursor:pointer; margin-top:8px; }
    .proceed-btn:disabled { opacity:0.6; cursor:not-allowed; }
    .error-msg { color:#ff4444; font-size:13px; margin-top:8px; text-align:center; }
    /* Payment page styles */
    .h8ed-payment-page { padding:8px; }
    .payment-logo { display:flex; align-items:center; gap:10px; padding:12px; background:#1a1a1a; border-radius:8px; margin-bottom:16px; }
    .payment-amount { margin-left:auto; font-size:20px; font-weight:bold; }
    .qr-code { display:block; margin:16px auto; border-radius:8px; background:#fff; padding:8px; }
    .copy-field { display:flex; align-items:center; gap:8px; padding:12px; background:#1a1a1a; border-radius:8px; margin-bottom:8px; }
    .copy-field strong { flex:1; font-size:14px; }
    .copy-field button { background:#333; color:#fff; border:none; padding:4px 10px; border-radius:6px; cursor:pointer; font-size:12px; }
    .open-app-btn { display:block; padding:12px; background:#1a0000; border:1px solid #ff0000; color:#ff0000; text-align:center; border-radius:8px; text-decoration:none; margin-bottom:16px; }
    .warning-box { background:#1a1200; border:1px solid #ffaa00; border-radius:8px; padding:12px; margin-bottom:8px; color:#ffaa00; font-size:13px; font-weight:bold; }
    .warning-box p { color:#aaa; font-weight:normal; margin:4px 0 0; font-size:12px; }
    .note-field { background:#0a0a1a; border:1px solid #4444ff; }
    .exact-amount { font-size:11px; letter-spacing:1px; color:#888; margin:12px 0 4px; display:flex; align-items:center; justify-content:space-between; }
    .how-to-pay { background:#1a1a1a; border-radius:8px; padding:12px; margin-top:12px; }
    .how-to-pay h4 { font-size:11px; letter-spacing:1px; color:#888; margin:0 0 8px; }
    .how-to-pay ol { margin:0; padding-left:20px; }
    .how-to-pay li { margin-bottom:6px; font-size:13px; color:#ccc; }
    .waiting-indicator { display:flex; align-items:center; gap:8px; padding:12px; color:#aaa; font-size:13px; margin-top:12px; }
    .dot { width:8px; height:8px; background:#00ff00; border-radius:50%; animation:pulse 1.5s infinite; flex-shrink:0; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
    .order-info { background:#1a1a1a; border-radius:8px; padding:12px; margin-top:12px; }
    .order-info h4 { font-size:11px; letter-spacing:1px; color:#888; margin:0 0 8px; }
    .info-row { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #222; font-size:13px; }
    .info-row:last-child { border-bottom:none; }
    .mono { font-family:monospace; font-size:11px; word-break:break-all; }
  `;
  document.head.appendChild(style);
}

// ─── Export for use in your existing site ───────────────
window.H8EDCheckout = {
  open: openCheckout,
  close: closeCheckout,
};
