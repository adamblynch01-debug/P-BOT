<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>H8ED — Digital Services</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Barlow:wght@400;500;600;700;900&family=Barlow+Condensed:wght@700;900&display=swap" rel="stylesheet">
<style>
/* ─── TOKENS ──────────────────────────────────────────── */
:root {
  --bg:        #080808;
  --surface:   #0f0f0f;
  --surface2:  #161616;
  --border:    #1e1e1e;
  --red:       #e8001a;
  --red-dim:   #5a000a;
  --red-glow:  rgba(232,0,26,0.15);
  --text:      #f0f0f0;
  --muted:     #555;
  --mono:      'Share Tech Mono', monospace;
  --sans:      'Barlow', sans-serif;
  --cond:      'Barlow Condensed', sans-serif;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html { scroll-behavior: smooth; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.6;
  overflow-x: hidden;
}

/* ─── SCANLINE OVERLAY ────────────────────────────────── */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0,0,0,0.03) 2px,
    rgba(0,0,0,0.03) 4px
  );
  pointer-events: none;
  z-index: 9998;
}

/* ─── NAV ─────────────────────────────────────────────── */
nav {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 32px;
  height: 60px;
  background: rgba(8,8,8,0.95);
  border-bottom: 1px solid var(--border);
  backdrop-filter: blur(12px);
}

.nav-logo {
  font-family: var(--cond);
  font-size: 26px;
  font-weight: 900;
  letter-spacing: 2px;
  color: var(--red);
  text-decoration: none;
  text-transform: uppercase;
}

.nav-logo span { color: var(--text); }

.nav-links {
  display: flex;
  align-items: center;
  gap: 28px;
  list-style: none;
}

.nav-links a {
  color: var(--muted);
  text-decoration: none;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 1px;
  text-transform: uppercase;
  transition: color 0.2s;
}

.nav-links a:hover { color: var(--text); }

.nav-cart {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--red);
  color: #fff;
  border: none;
  padding: 8px 16px;
  font-family: var(--mono);
  font-size: 13px;
  cursor: pointer;
  transition: opacity 0.2s;
  clip-path: polygon(8px 0%, 100% 0%, calc(100% - 8px) 100%, 0% 100%);
}

.nav-cart:hover { opacity: 0.85; }
.cart-count { background: #fff; color: var(--red); border-radius: 50%; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; }

/* ─── HERO ────────────────────────────────────────────── */
.hero {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 80px 24px 48px;
  position: relative;
  overflow: hidden;
}

.hero-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(232,0,26,0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(232,0,26,0.04) 1px, transparent 1px);
  background-size: 60px 60px;
  mask-image: radial-gradient(ellipse 80% 60% at 50% 50%, black 30%, transparent 100%);
}

.hero-eyebrow {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--red);
  letter-spacing: 3px;
  text-transform: uppercase;
  margin-bottom: 20px;
}

.hero h1 {
  font-family: var(--cond);
  font-size: clamp(64px, 14vw, 140px);
  font-weight: 900;
  line-height: 0.9;
  letter-spacing: -2px;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.hero h1 .slash {
  color: var(--red);
  font-style: italic;
}

.hero-sub {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--muted);
  letter-spacing: 2px;
  margin-bottom: 40px;
}

.hero-cta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: center;
}

.btn-primary {
  background: var(--red);
  color: #fff;
  border: none;
  padding: 14px 32px;
  font-family: var(--cond);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 2px;
  text-transform: uppercase;
  cursor: pointer;
  clip-path: polygon(10px 0%, 100% 0%, calc(100% - 10px) 100%, 0% 100%);
  transition: opacity 0.2s;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.btn-primary:hover { opacity: 0.85; }

.btn-outline {
  background: transparent;
  color: var(--muted);
  border: 1px solid var(--border);
  padding: 14px 32px;
  font-family: var(--cond);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 2px;
  text-transform: uppercase;
  cursor: pointer;
  transition: all 0.2s;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
}

.btn-outline:hover { color: var(--text); border-color: var(--muted); }

/* ─── TICKER ──────────────────────────────────────────── */
.ticker {
  background: var(--red);
  padding: 10px 0;
  overflow: hidden;
  white-space: nowrap;
}

.ticker-inner {
  display: inline-flex;
  animation: ticker 20s linear infinite;
  gap: 0;
}

.ticker-inner span {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 2px;
  color: rgba(255,255,255,0.9);
  padding: 0 32px;
}

.ticker-inner span::before { content: '◆ '; }

@keyframes ticker { from { transform: translateX(0); } to { transform: translateX(-50%); } }

/* ─── SECTION ─────────────────────────────────────────── */
section {
  padding: 80px 24px;
  max-width: 1200px;
  margin: 0 auto;
}

.section-label {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 3px;
  color: var(--red);
  text-transform: uppercase;
  margin-bottom: 12px;
}

.section-title {
  font-family: var(--cond);
  font-size: clamp(32px, 5vw, 52px);
  font-weight: 900;
  text-transform: uppercase;
  letter-spacing: -1px;
  margin-bottom: 8px;
}

.section-sub {
  color: var(--muted);
  font-size: 14px;
  margin-bottom: 48px;
}

/* ─── PRODUCTS ────────────────────────────────────────── */
#shop { max-width: 1200px; }

.products-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
}

.product-card {
  background: var(--surface);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: background 0.2s;
  position: relative;
  overflow: hidden;
}

.product-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: var(--red);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 0.3s;
}

.product-card:hover { background: var(--surface2); }
.product-card:hover::before { transform: scaleX(1); }

.product-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--red);
  text-transform: uppercase;
}

.badge-dot { width: 6px; height: 6px; background: var(--red); border-radius: 50%; animation: pulse 1.5s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

.product-name {
  font-family: var(--cond);
  font-size: 22px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  line-height: 1.1;
}

.product-desc {
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
  flex: 1;
}

.product-features {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.product-features li {
  font-family: var(--mono);
  font-size: 11px;
  color: #666;
  display: flex;
  align-items: center;
  gap: 6px;
}

.product-features li::before { content: '—'; color: var(--red); }

.product-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.product-price {
  font-family: var(--cond);
  font-size: 28px;
  font-weight: 900;
  color: var(--text);
}

.product-price span {
  font-size: 14px;
  color: var(--muted);
  font-weight: 400;
  font-family: var(--sans);
}

.add-btn {
  background: transparent;
  border: 1px solid var(--red);
  color: var(--red);
  padding: 8px 16px;
  font-family: var(--mono);
  font-size: 12px;
  cursor: pointer;
  letter-spacing: 1px;
  text-transform: uppercase;
  transition: all 0.2s;
  clip-path: polygon(6px 0%, 100% 0%, calc(100% - 6px) 100%, 0% 100%);
}

.add-btn:hover { background: var(--red); color: #fff; }
.add-btn.added { background: var(--red); color: #fff; }

/* ─── PAYMENT METHODS SECTION ─────────────────────────── */
.methods-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
  margin-top: 40px;
}

.method-card {
  background: var(--surface);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.method-icon {
  font-size: 28px;
  margin-bottom: 4px;
}

.method-name {
  font-family: var(--cond);
  font-size: 18px;
  font-weight: 700;
  text-transform: uppercase;
}

.method-tag {
  font-family: var(--mono);
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 2px;
  display: inline-flex;
  width: fit-content;
}

.method-tag.fee { background: #1a0a00; color: #ff8800; }
.method-tag.discount { background: #001a00; color: #00cc44; }
.method-tag.neutral { background: var(--surface2); color: var(--muted); }

.method-note { font-size: 12px; color: var(--muted); }

/* ─── CART SIDEBAR ────────────────────────────────────── */
.cart-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.7);
  z-index: 200;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s;
}

.cart-overlay.open { opacity: 1; pointer-events: all; }

.cart-sidebar {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: 100%;
  max-width: 420px;
  background: var(--surface);
  border-left: 1px solid var(--border);
  z-index: 201;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
}

.cart-sidebar.open { transform: translateX(0); }

.cart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border);
}

.cart-header h2 {
  font-family: var(--cond);
  font-size: 22px;
  font-weight: 900;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.cart-close {
  background: none;
  border: none;
  color: var(--muted);
  font-size: 22px;
  cursor: pointer;
  line-height: 1;
  padding: 4px;
}

.cart-close:hover { color: var(--text); }

.cart-items {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cart-item-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--surface2);
  border: 1px solid var(--border);
}

.cart-item-info { flex: 1; }

.cart-item-name {
  font-family: var(--cond);
  font-size: 16px;
  font-weight: 700;
  text-transform: uppercase;
}

.cart-item-price {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
}

.cart-item-qty {
  display: flex;
  align-items: center;
  gap: 8px;
}

.qty-btn {
  width: 24px; height: 24px;
  background: var(--border);
  border: none;
  color: var(--text);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}

.qty-btn:hover { background: var(--red); }
.qty-num { font-family: var(--mono); font-size: 14px; min-width: 20px; text-align: center; }

.cart-remove { background: none; border: none; color: #444; cursor: pointer; font-size: 16px; padding: 4px; }
.cart-remove:hover { color: var(--red); }

.cart-empty {
  text-align: center;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 13px;
  padding: 48px 0;
}

.cart-footer {
  border-top: 1px solid var(--border);
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cart-total-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.cart-total-label { font-family: var(--mono); font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
.cart-total-value { font-family: var(--cond); font-size: 28px; font-weight: 900; }

.checkout-btn {
  width: 100%;
  background: var(--red);
  color: #fff;
  border: none;
  padding: 16px;
  font-family: var(--cond);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 2px;
  text-transform: uppercase;
  cursor: pointer;
  clip-path: polygon(12px 0%, 100% 0%, calc(100% - 12px) 100%, 0% 100%);
  transition: opacity 0.2s;
}

.checkout-btn:hover { opacity: 0.88; }
.checkout-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ─── CHECKOUT MODAL ──────────────────────────────────── */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.9);
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s;
}

.modal-overlay.open { opacity: 1; pointer-events: all; }

.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  width: 100%;
  max-width: 500px;
  max-height: 90vh;
  overflow-y: auto;
  position: relative;
  transform: translateY(20px);
  transition: transform 0.3s;
}

.modal-overlay.open .modal { transform: translateY(0); }

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--surface);
  z-index: 1;
}

.modal-header h2 {
  font-family: var(--cond);
  font-size: 20px;
  font-weight: 900;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.modal-close {
  background: none;
  border: none;
  color: var(--muted);
  font-size: 22px;
  cursor: pointer;
}

.modal-close:hover { color: var(--text); }

.modal-body { padding: 24px; }

.modal-section-label {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 2px;
  color: var(--muted);
  text-transform: uppercase;
  margin-bottom: 10px;
}

.order-summary-mini {
  background: var(--surface2);
  border: 1px solid var(--border);
  padding: 12px 16px;
  margin-bottom: 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.order-line {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
}

.order-line.total {
  border-top: 1px solid var(--border);
  padding-top: 8px;
  margin-top: 4px;
  font-family: var(--cond);
  font-size: 18px;
  font-weight: 700;
}

input[type="email"], input[type="text"] {
  width: 100%;
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 12px 14px;
  font-family: var(--sans);
  font-size: 14px;
  margin-bottom: 8px;
  outline: none;
  transition: border-color 0.2s;
}

input[type="email"]:focus, input[type="text"]:focus {
  border-color: var(--red);
}

input::placeholder { color: #444; }

.payment-options { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }

.payment-opt {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--surface2);
  border: 2px solid var(--border);
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
  user-select: none;
}

.payment-opt:hover { border-color: #333; }
.payment-opt.selected { border-color: var(--red); background: var(--red-glow); }
.payment-opt input[type="radio"] { display: none; }

.pay-icon { font-size: 20px; flex-shrink: 0; }

.pay-info { flex: 1; }
.pay-name { font-family: var(--cond); font-size: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
.pay-desc { font-family: var(--mono); font-size: 10px; color: var(--muted); margin-top: 1px; }

.pay-badge {
  font-family: var(--mono);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.pay-badge.fee { background: #1a0a00; color: #ff8800; }
.pay-badge.disc { background: #001a00; color: #00cc44; }

.tos-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 16px;
}

.tos-row input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  flex-shrink: 0;
  accent-color: var(--red);
  margin-top: 2px;
}

.tos-row label {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.4;
  cursor: pointer;
}

.tos-row a { color: var(--red); text-decoration: none; }

.proceed-btn {
  width: 100%;
  background: var(--red);
  color: #fff;
  border: none;
  padding: 15px;
  font-family: var(--cond);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 2px;
  text-transform: uppercase;
  cursor: pointer;
  clip-path: polygon(12px 0%, 100% 0%, calc(100% - 12px) 100%, 0% 100%);
  transition: opacity 0.2s;
}

.proceed-btn:hover { opacity: 0.88; }
.proceed-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.form-error {
  color: #ff4444;
  font-family: var(--mono);
  font-size: 11px;
  margin-top: 8px;
  text-align: center;
}

/* ─── PAYMENT PAGE ────────────────────────────────────── */
#payment-step { display: none; }

.pay-header-row {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--surface2);
  border: 1px solid var(--border);
  padding: 14px 16px;
  margin-bottom: 16px;
}

.pay-method-icon { font-size: 28px; }

.pay-method-label {
  flex: 1;
}

.pay-method-name { font-family: var(--cond); font-size: 18px; font-weight: 700; text-transform: uppercase; }
.pay-method-sub { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.pay-amount { font-family: var(--cond); font-size: 24px; font-weight: 900; color: var(--red); }

.qr-wrap {
  display: flex;
  justify-content: center;
  margin: 16px 0;
}

.qr-wrap img {
  background: #fff;
  padding: 10px;
  border-radius: 4px;
  max-width: 180px;
}

.copy-row {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--surface2);
  border: 1px solid var(--border);
  padding: 10px 14px;
  margin-bottom: 8px;
}

.copy-row-label {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  min-width: 60px;
  flex-shrink: 0;
}

.copy-row-value {
  font-family: var(--mono);
  font-size: 13px;
  flex: 1;
  word-break: break-all;
}

.copy-btn {
  background: var(--border);
  border: none;
  color: var(--muted);
  padding: 4px 10px;
  font-family: var(--mono);
  font-size: 10px;
  cursor: pointer;
  letter-spacing: 1px;
  transition: all 0.2s;
  flex-shrink: 0;
  text-transform: uppercase;
}

.copy-btn:hover { background: var(--red); color: #fff; }
.copy-btn.copied { background: #004400; color: #00ff44; }

.open-app-link {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--red);
  color: var(--red);
  text-decoration: none;
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin-bottom: 16px;
  transition: background 0.2s;
}

.open-app-link:hover { background: var(--red-glow); }

.warning-banner {
  background: #140d00;
  border: 1px solid #5a3800;
  border-left: 3px solid #ff8800;
  padding: 12px 14px;
  margin-bottom: 8px;
}

.warning-banner strong {
  font-family: var(--mono);
  font-size: 11px;
  color: #ff8800;
  letter-spacing: 1px;
  text-transform: uppercase;
  display: block;
  margin-bottom: 4px;
}

.warning-banner p { font-size: 12px; color: #886644; line-height: 1.4; }

.note-row {
  border-color: #223;
  background: #0a0a18;
}

.note-row .copy-row-value { color: #8888ff; font-size: 16px; font-weight: 700; }

.exact-amount-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  margin-bottom: 8px;
}

.exact-label { font-family: var(--mono); font-size: 10px; color: var(--muted); letter-spacing: 1px; text-transform: uppercase; }

.how-to-box {
  background: var(--surface2);
  border: 1px solid var(--border);
  padding: 14px 16px;
  margin-top: 12px;
}

.how-to-box h4 { font-family: var(--mono); font-size: 10px; letter-spacing: 2px; color: var(--muted); text-transform: uppercase; margin-bottom: 10px; }

.how-to-box ol { padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
.how-to-box li { font-size: 13px; color: #888; line-height: 1.4; }

.status-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--surface2);
  border: 1px solid var(--border);
  margin-top: 16px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--muted);
}

.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #00ff44; flex-shrink: 0; animation: pulse 1.5s infinite; }
.status-dot.paid { background: #ffaa00; animation: none; }
.status-dot.delivered { background: #00ff44; animation: none; }

.order-info-box {
  background: var(--surface2);
  border: 1px solid var(--border);
  padding: 14px 16px;
  margin-top: 12px;
}

.order-info-box h4 { font-family: var(--mono); font-size: 10px; letter-spacing: 2px; color: var(--muted); text-transform: uppercase; margin-bottom: 10px; }

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}

.info-row:last-child { border-bottom: none; }
.info-key { color: var(--muted); flex-shrink: 0; margin-right: 12px; }
.info-val { font-family: var(--mono); font-size: 11px; text-align: right; word-break: break-all; }

/* ─── FOOTER ──────────────────────────────────────────── */
footer {
  border-top: 1px solid var(--border);
  padding: 40px 24px;
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: gap;
  gap: 16px;
}

.footer-logo {
  font-family: var(--cond);
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 2px;
  color: var(--red);
}

.footer-links { display: flex; gap: 20px; }
.footer-links a { font-family: var(--mono); font-size: 11px; color: var(--muted); text-decoration: none; letter-spacing: 1px; transition: color 0.2s; }
.footer-links a:hover { color: var(--text); }

.footer-copy { font-family: var(--mono); font-size: 11px; color: #333; }

/* ─── TOAST ───────────────────────────────────────────── */
.toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-left: 3px solid var(--red);
  padding: 12px 18px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
  z-index: 999;
  opacity: 0;
  transform: translateY(8px);
  transition: all 0.25s;
  pointer-events: none;
  max-width: 280px;
}

.toast.show { opacity: 1; transform: translateY(0); }

/* ─── RESPONSIVE ──────────────────────────────────────── */
@media (max-width: 640px) {
  nav { padding: 0 16px; }
  .nav-links { display: none; }
  section { padding: 60px 16px; }
  .modal { max-height: 100vh; height: 100%; border-radius: 0; }
  .cart-sidebar { max-width: 100%; }
}
</style>
</head>
<body>

<!-- ─── NAV ─────────────────────────────────────────── -->
<nav>
  <a href="#" class="nav-logo">H8<span>ED</span></a>
  <ul class="nav-links">
    <li><a href="#shop">Shop</a></li>
    <li><a href="#payment">Payment</a></li>
    <li><a href="https://discord.gg/placeholder" target="_blank">Discord</a></li>
  </ul>
  <button class="nav-cart" onclick="toggleCart()">
    🛒 CART <span class="cart-count" id="cart-count">0</span>
  </button>
</nav>

<!-- ─── HERO ─────────────────────────────────────────── -->
<div class="hero">
  <div class="hero-grid"></div>
  <p class="hero-eyebrow">// DIGITAL SERVICES //</p>
  <h1>H<span class="slash">8</span>ED</h1>
  <p class="hero-sub">PREMIUM TOOLS · INSTANT DELIVERY · SECURE CHECKOUT</p>
  <div class="hero-cta">
    <a href="#shop" class="btn-primary">Browse Store →</a>
    <a href="https://discord.gg/placeholder" class="btn-outline" target="_blank">Join Discord</a>
  </div>
</div>

<!-- ─── TICKER ───────────────────────────────────────── -->
<div class="ticker">
  <div class="ticker-inner" id="ticker">
    <span>INSTANT DELIVERY</span>
    <span>CRYPTO ACCEPTED</span>
    <span>CASH APP</span>
    <span>PAYPAL F&F</span>
    <span>BITCOIN</span>
    <span>LITECOIN</span>
    <span>SECURE CHECKOUT</span>
    <span>24/7 SUPPORT</span>
    <span>INSTANT DELIVERY</span>
    <span>CRYPTO ACCEPTED</span>
    <span>CASH APP</span>
    <span>PAYPAL F&F</span>
    <span>BITCOIN</span>
    <span>LITECOIN</span>
    <span>SECURE CHECKOUT</span>
    <span>24/7 SUPPORT</span>
  </div>
</div>

<!-- ─── SHOP ─────────────────────────────────────────── -->
<section id="shop">
  <p class="section-label">// STORE //</p>
  <h2 class="section-title">Products</h2>
  <p class="section-sub">All products delivered instantly after payment confirmation.</p>
  <div class="products-grid" id="products-grid">
    <!-- Injected by JS -->
  </div>
</section>

<!-- ─── PAYMENT METHODS ───────────────────────────────── -->
<section id="payment" style="padding-top:0">
  <p class="section-label">// PAYMENTS //</p>
  <h2 class="section-title">We Accept</h2>
  <p class="section-sub">All transactions confirmed automatically. No waiting on manual approval.</p>
  <div class="methods-grid">
    <div class="method-card">
      <div class="method-icon">💵</div>
      <div class="method-name">Cash App</div>
      <div class="method-tag fee">+10% fee</div>
      <div class="method-note">Send with note code. Auto-confirmed via email.</div>
    </div>
    <div class="method-card">
      <div class="method-icon">🅿️</div>
      <div class="method-name">PayPal F&F</div>
      <div class="method-tag fee">+10% fee</div>
      <div class="method-note">Friends & Family only. Include note in memo.</div>
    </div>
    <div class="method-card">
      <div class="method-icon">₿</div>
      <div class="method-name">Bitcoin</div>
      <div class="method-tag discount">−5% discount</div>
      <div class="method-note">Unique address per order. 1 confirmation required.</div>
    </div>
    <div class="method-card">
      <div class="method-icon">Ł</div>
      <div class="method-name">Litecoin</div>
      <div class="method-tag discount">−5% discount</div>
      <div class="method-note">Faster confirmations than BTC. Same discount.</div>
    </div>
  </div>
</section>

<!-- ─── FOOTER ───────────────────────────────────────── -->
<footer>
  <div class="footer-logo">H8ED</div>
  <div class="footer-links">
    <a href="#">Terms</a>
    <a href="#">Privacy</a>
    <a href="#">Refunds</a>
    <a href="https://discord.gg/placeholder" target="_blank">Discord</a>
  </div>
  <div class="footer-copy">© 2026 H8ED. All rights reserved.</div>
</footer>

<!-- ─── CART SIDEBAR ──────────────────────────────────── -->
<div class="cart-overlay" id="cart-overlay" onclick="toggleCart()"></div>
<div class="cart-sidebar" id="cart-sidebar">
  <div class="cart-header">
    <h2>Your Cart</h2>
    <button class="cart-close" onclick="toggleCart()">✕</button>
  </div>
  <div class="cart-items" id="cart-items-list"></div>
  <div class="cart-footer">
    <div class="cart-total-row">
      <span class="cart-total-label">Total</span>
      <span class="cart-total-value" id="cart-total">$0.00</span>
    </div>
    <button class="checkout-btn" id="checkout-btn" onclick="openCheckout()" disabled>
      Checkout →
    </button>
  </div>
</div>

<!-- ─── CHECKOUT MODAL ────────────────────────────────── -->
<div class="modal-overlay" id="modal-overlay">
  <div class="modal">
    <div class="modal-header">
      <h2 id="modal-title">Checkout</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">

      <!-- Step 1: Order form -->
      <div id="checkout-step">
        <p class="modal-section-label">Order Summary</p>
        <div class="order-summary-mini" id="modal-summary"></div>

        <p class="modal-section-label">Contact & Delivery</p>
        <input type="email" id="input-email" placeholder="Email address *" autocomplete="email">
        <input type="text" id="input-discord" placeholder="Discord User ID (optional — for DM delivery)">

        <p class="modal-section-label" style="margin-top:16px">Payment Method</p>
        <div class="payment-options" id="payment-options">
          <label class="payment-opt" onclick="selectPayment(this,'cashapp')">
            <input type="radio" name="pay" value="cashapp">
            <span class="pay-icon"><img src="https://upload.wikimedia.org/wikipedia/commons/c/c5/Square_Cash_app_logo.svg" style="width:28px;height:28px;border-radius:6px"></span>
            <span class="pay-info">
              <span class="pay-name">Cash App</span>
              <span class="pay-desc">Via Cash App · Auto-confirmed</span>
            </span>
            <span class="pay-badge fee">+10%</span>
          </label>
          <label class="payment-opt" onclick="selectPayment(this,'paypal')">
            <input type="radio" name="pay" value="paypal">
            <span class="pay-icon"><img src="https://upload.wikimedia.org/wikipedia/commons/b/b5/PayPal.svg" style="width:48px;height:28px;object-fit:contain"></span>
            <span class="pay-info">
              <span class="pay-name">PayPal F&F</span>
              <span class="pay-desc">Friends & Family · Include note</span>
            </span>
            <span class="pay-badge fee">+10%</span>
          </label>
          <label class="payment-opt" onclick="selectPayment(this,'btc')">
            <input type="radio" name="pay" value="btc">
            <span class="pay-icon"><img src="https://upload.wikimedia.org/wikipedia/commons/4/46/Bitcoin.svg" style="width:28px;height:28px"></span>
            <span class="pay-info">
              <span class="pay-name">Bitcoin</span>
              <span class="pay-desc">Via Bitcoin Network · 1 confirmation</span>
            </span>
            <span class="pay-badge disc">−5%</span>
          </label>
          <label class="payment-opt" onclick="selectPayment(this,'ltc')">
            <input type="radio" name="pay" value="ltc">
            <span class="pay-icon"><img src="https://upload.wikimedia.org/wikipedia/commons/1/1c/Litecoin.svg" style="width:28px;height:28px"></span>
            <span class="pay-info">
              <span class="pay-name">Litecoin</span>
              <span class="pay-desc">Via Litecoin Network · Fast confirm</span>
            </span>
            <span class="pay-badge disc">−5%</span>
          </label>
        </div>

        <div class="tos-row">
          <input type="checkbox" id="tos-check">
          <label for="tos-check">I have read and agree to H8ED's <a href="#">Terms of Service</a>.</label>
        </div>

        <button class="proceed-btn" id="proceed-btn" onclick="submitCheckout()">
          Proceed to Payment →
        </button>
        <div class="form-error" id="form-error"></div>
      </div>

      <!-- Step 2: Payment instructions -->
      <div id="payment-step">
        <div class="pay-header-row">
          <span class="pay-method-icon" id="pay-icon"></span>
          <span class="pay-method-label">
            <span class="pay-method-name" id="pay-name"></span>
            <span class="pay-method-sub" id="pay-sub"></span>
          </span>
          <span class="pay-amount" id="pay-amount"></span>
        </div>

        <div id="qr-section" class="qr-wrap" style="display:none">
          <img id="qr-img" src="" alt="Payment QR Code">
        </div>

        <div id="pay-fields"></div>

        <div id="open-app-section" style="display:none">
          <a id="open-app-link" href="#" target="_blank" class="open-app-link">Open App ↗</a>
        </div>

        <div class="warning-banner">
          <strong>⚠ Add the note to your payment or it will be ignored</strong>
          <p>Your order won't be automatically processed without the correct note in the memo field.</p>
        </div>

        <div class="copy-row note-row">
          <span class="copy-row-label">Note</span>
          <span class="copy-row-value" id="pay-note-val"></span>
          <button class="copy-btn" onclick="copyVal('pay-note-val', this)">Copy</button>
        </div>

        <div class="exact-amount-row">
          <span class="exact-label">Send exact amount</span>
          <div class="copy-row" style="margin:0; padding:6px 12px; flex-shrink:0">
            <span class="copy-row-value" id="pay-exact"></span>
            <button class="copy-btn" onclick="copyVal('pay-exact', this)" style="margin-left:8px">Copy</button>
          </div>
        </div>

        <div class="how-to-box" id="how-to-box"></div>

        <div class="status-bar">
          <span class="status-dot" id="status-dot"></span>
          <span id="status-text">Waiting for payment. This page updates automatically.</span>
        </div>

        <div class="order-info-box" id="order-info-box">
          <h4>Order Information</h4>
          <div id="order-info-rows"></div>
        </div>
      </div>

    </div>
  </div>
</div>

<!-- ─── TOAST ─────────────────────────────────────────── -->
<div class="toast" id="toast"></div>

<script>
// ─── CONFIG ─────────────────────────────────────────────
// !! UPDATE THIS to your Railway backend URL when deploying !!
const BACKEND_URL = 'https://captivating-happiness-production-c944.up.railway.app';

// ─── PRODUCTS (hardcoded for now — can fetch from /api/products later) ──
const PRODUCTS = [
  {
    id: 'prod-001',
    name: 'Starter Pack',
    description: 'Entry level access for new members. Includes basic tool access and support.',
    price: 10.00,
    category: 'Access',
    features: ['Basic tool access', 'Discord role', '7-day duration', 'Email support'],
    badge: 'IN STOCK',
  },
  {
    id: 'prod-002',
    name: 'Pro Access',
    description: 'Full suite access with priority support and extended duration.',
    price: 25.00,
    category: 'Access',
    features: ['Full tool access', 'Priority support', '30-day duration', 'Discord DM support'],
    badge: 'POPULAR',
  },
  {
    id: 'prod-003',
    name: 'Lifetime Key',
    description: 'One-time purchase for permanent access. Never pay again.',
    price: 75.00,
    category: 'Access',
    features: ['Permanent access', 'All tools included', 'VIP Discord role', 'Priority support'],
    badge: 'BEST VALUE',
  },
  {
    id: 'prod-004',
    name: 'SMS Credits × 10',
    description: '10 virtual SMS number credits for verification purposes.',
    price: 5.00,
    category: 'Credits',
    features: ['10 SMS numbers', 'Multiple countries', 'Instant delivery', 'No expiry'],
    badge: 'IN STOCK',
  },
];

// ─── CART STATE ──────────────────────────────────────────
let cart = [];
let selectedPayment = null;
let pollInterval = null;

// ─── RENDER PRODUCTS ─────────────────────────────────────
function renderProducts() {
  const grid = document.getElementById('products-grid');
  grid.innerHTML = PRODUCTS.map(p => `
    <div class="product-card">
      <div class="product-badge">
        <span class="badge-dot"></span> ${p.badge}
      </div>
      <div class="product-name">${p.name}</div>
      <div class="product-desc">${p.description}</div>
      <ul class="product-features">
        ${p.features.map(f => `<li>${f}</li>`).join('')}
      </ul>
      <div class="product-footer">
        <div class="product-price">$${p.price.toFixed(2)} <span>USD</span></div>
        <button class="add-btn" id="add-${p.id}" onclick="addToCart('${p.id}')">
          ADD →
        </button>
      </div>
    </div>
  `).join('');
}

// ─── CART ────────────────────────────────────────────────
function addToCart(productId) {
  const product = PRODUCTS.find(p => p.id === productId);
  if (!product) return;

  const existing = cart.find(i => i.id === productId);
  if (existing) {
    existing.qty++;
  } else {
    cart.push({ ...product, qty: 1 });
  }

  updateCartUI();
  showToast(`${product.name} added to cart`);

  const btn = document.getElementById(`add-${productId}`);
  if (btn) {
    btn.textContent = 'ADDED ✓';
    btn.classList.add('added');
    setTimeout(() => {
      btn.textContent = 'ADD →';
      btn.classList.remove('added');
    }, 1500);
  }
}

function removeFromCart(productId) {
  cart = cart.filter(i => i.id !== productId);
  updateCartUI();
}

function changeQty(productId, delta) {
  const item = cart.find(i => i.id === productId);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) removeFromCart(productId);
  else updateCartUI();
}

function updateCartUI() {
  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const count = cart.reduce((s, i) => s + i.qty, 0);

  document.getElementById('cart-count').textContent = count;
  document.getElementById('cart-total').textContent = `$${total.toFixed(2)}`;
  document.getElementById('checkout-btn').disabled = cart.length === 0;

  const list = document.getElementById('cart-items-list');
  if (cart.length === 0) {
    list.innerHTML = '<div class="cart-empty">// CART IS EMPTY //</div>';
    return;
  }

  list.innerHTML = cart.map(i => `
    <div class="cart-item-row">
      <div class="cart-item-info">
        <div class="cart-item-name">${i.name}</div>
        <div class="cart-item-price">$${i.price.toFixed(2)} each</div>
      </div>
      <div class="cart-item-qty">
        <button class="qty-btn" onclick="changeQty('${i.id}', -1)">−</button>
        <span class="qty-num">${i.qty}</span>
        <button class="qty-btn" onclick="changeQty('${i.id}', 1)">+</button>
      </div>
      <button class="cart-remove" onclick="removeFromCart('${i.id}')">✕</button>
    </div>
  `).join('');
}

function toggleCart() {
  document.getElementById('cart-overlay').classList.toggle('open');
  document.getElementById('cart-sidebar').classList.toggle('open');
}

// ─── CHECKOUT ────────────────────────────────────────────
function openCheckout() {
  if (cart.length === 0) return;
  toggleCart();

  // Populate summary
  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
  document.getElementById('modal-summary').innerHTML =
    cart.map(i => `
      <div class="order-line">
        <span>${i.name} ×${i.qty}</span>
        <span>$${(i.price * i.qty).toFixed(2)}</span>
      </div>
    `).join('') +
    `<div class="order-line total"><span>Total</span><span>$${total.toFixed(2)}</span></div>`;

  // Reset form
  document.getElementById('checkout-step').style.display = 'block';
  document.getElementById('payment-step').style.display = 'none';
  document.getElementById('modal-title').textContent = 'Checkout';
  document.getElementById('form-error').textContent = '';
  selectedPayment = null;
  document.querySelectorAll('.payment-opt').forEach(el => el.classList.remove('selected'));
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }

  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

function selectPayment(el, method) {
  selectedPayment = method;
  document.querySelectorAll('.payment-opt').forEach(e => e.classList.remove('selected'));
  el.classList.add('selected');
}

async function submitCheckout() {
  const email = document.getElementById('input-email').value.trim();
  const discordId = document.getElementById('input-discord').value.trim();
  const tos = document.getElementById('tos-check').checked;
  const errEl = document.getElementById('form-error');

  errEl.textContent = '';
  if (!email || !email.includes('@')) return (errEl.textContent = 'Valid email required.');
  if (!selectedPayment) return (errEl.textContent = 'Select a payment method.');
  if (!tos) return (errEl.textContent = 'Please agree to the Terms of Service.');

  const btn = document.getElementById('proceed-btn');
  btn.textContent = 'Creating order...';
  btn.disabled = true;

  try {
    const items = cart.map(i => ({ id: i.id, name: i.name, price: i.price, qty: i.qty }));

    const res = await fetch(`${BACKEND_URL}/api/orders/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items,
        email,
        discord_id: discordId || null,
        payment_method: selectedPayment,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }

    const order = await res.json();
    showPaymentPage(order);

  } catch (err) {
    errEl.textContent = `Error: ${err.message}`;
    btn.textContent = 'Proceed to Payment →';
    btn.disabled = false;
  }
}

// ─── PAYMENT PAGE ─────────────────────────────────────────
function showPaymentPage(order) {
  document.getElementById('checkout-step').style.display = 'none';
  document.getElementById('payment-step').style.display = 'block';
  document.getElementById('modal-title').textContent = 'Complete Payment';

  const { payment_method, payment_info, total, order_id, fee_note, expires_at } = order;

  const methodMeta = {
    cashapp: { icon: '💵', name: 'Cash App',    sub: `via Cash App · ${payment_info.cashtag}` },
    paypal:  { icon: '🅿️', name: 'PayPal F&F',  sub: `via PayPal · ${payment_info.email}` },
    btc:     { icon: '₿',  name: 'Bitcoin',     sub: `via Bitcoin Network` },
    ltc:     { icon: 'Ł',  name: 'Litecoin',    sub: `via Litecoin Network` },
  }[payment_method] || { icon: '💳', name: payment_method, sub: '' };

  document.getElementById('pay-icon').textContent = methodMeta.icon;
  document.getElementById('pay-name').textContent = methodMeta.name;
  document.getElementById('pay-sub').textContent = methodMeta.sub;
  document.getElementById('pay-amount').textContent = `$${total}`;
  document.getElementById('pay-note-val').textContent = payment_info.note || '—';
  document.getElementById('pay-exact').textContent = `$${total}`;

  // QR code
  const qrSection = document.getElementById('qr-section');
  const qrImg = document.getElementById('qr-img');
  let qrData = null;

  if (payment_method === 'cashapp') qrData = `https://cash.app/${payment_info.cashtag}`;
  if (payment_method === 'paypal')  qrData = `https://www.paypal.com/paypalme/${payment_info.email}`;
  if (payment_method === 'btc')     qrData = `bitcoin:${payment_info.address}`;
  if (payment_method === 'ltc')     qrData = `litecoin:${payment_info.address}`;

  if (qrData) {
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(qrData)}`;
    qrSection.style.display = 'flex';
  } else {
    qrSection.style.display = 'none';
  }

  // Extra fields
  const fieldsEl = document.getElementById('pay-fields');
  if (payment_method === 'cashapp') {
    fieldsEl.innerHTML = `
      <div class="copy-row">
        <span class="copy-row-label">Cashtag</span>
        <span class="copy-row-value" id="field-cashtag">${payment_info.cashtag}</span>
        <button class="copy-btn" onclick="copyVal('field-cashtag', this)">Copy</button>
      </div>`;
    const appLink = document.getElementById('open-app-link');
    appLink.href = `https://cash.app/${payment_info.cashtag}`;
    appLink.textContent = `Open Cash App ↗`;
    document.getElementById('open-app-section').style.display = 'block';
  } else if (payment_method === 'paypal') {
    fieldsEl.innerHTML = `
      <div class="copy-row">
        <span class="copy-row-label">Email</span>
        <span class="copy-row-value" id="field-email">${payment_info.email}</span>
        <button class="copy-btn" onclick="copyVal('field-email', this)">Copy</button>
      </div>`;
    const appLink = document.getElementById('open-app-link');
    appLink.href = `https://www.paypal.com/myaccount/transfer/homepage/pay`;
    appLink.textContent = `Open PayPal ↗`;
    document.getElementById('open-app-section').style.display = 'block';
  } else if (payment_method === 'btc' || payment_method === 'ltc') {
    fieldsEl.innerHTML = `
      <div class="copy-row">
        <span class="copy-row-label">Address</span>
        <span class="copy-row-value" id="field-addr" style="font-size:10px">${payment_info.address}</span>
        <button class="copy-btn" onclick="copyVal('field-addr', this)">Copy</button>
      </div>`;
    // Hide note warning for crypto — address is unique per order
    document.querySelector('.warning-banner').style.display = 'none';
    document.querySelector('.note-row').style.display = 'none';
    document.getElementById('open-app-section').style.display = 'none';
  }

  // How to pay
  const howTo = {
    cashapp: `<ol>
      <li>Open Cash App on your phone</li>
      <li>Scan the QR code or send to ${payment_info.cashtag}</li>
      <li>Add the note shown above in the memo/note field</li>
      <li>Send the exact amount. Your order updates automatically.</li>
    </ol>`,
    paypal: `<ol>
      <li>Log in to your PayPal account</li>
      <li>Select "Send & Request" → "Send"</li>
      <li>Enter email: ${payment_info.email}</li>
      <li>Select "Sending to a friend" (Friends & Family)</li>
      <li>Enter exact amount: $${total}</li>
      <li>Add the note above in the "What's this for?" field</li>
      <li>Send. Your order updates automatically.</li>
    </ol>`,
    btc: `<ol>
      <li>Open your Bitcoin wallet</li>
      <li>Scan the QR code or copy the address above</li>
      <li>Send the exact BTC equivalent of $${total}</li>
      <li>Your order confirms automatically after 1 confirmation.</li>
    </ol>`,
    ltc: `<ol>
      <li>Open your Litecoin wallet</li>
      <li>Scan the QR code or copy the address above</li>
      <li>Send the exact LTC equivalent of $${total}</li>
      <li>Your order confirms automatically after 1 confirmation.</li>
    </ol>`,
  }[payment_method] || '';

  document.getElementById('how-to-box').innerHTML = `<h4>How to Pay</h4>${howTo}`;

  // Order info
  document.getElementById('order-info-rows').innerHTML = `
    <div class="info-row"><span class="info-key">Invoice ID</span><span class="info-val">${order_id}</span></div>
    <div class="info-row"><span class="info-key">Method</span><span class="info-val">${payment_method.toUpperCase()}</span></div>
    <div class="info-row"><span class="info-key">Total</span><span class="info-val">$${total}${fee_note ? ` (${fee_note})` : ''}</span></div>
    <div class="info-row"><span class="info-key">Created</span><span class="info-val">${new Date().toLocaleString()}</span></div>
    <div class="info-row"><span class="info-key">Expires</span><span class="info-val">${new Date(expires_at).toLocaleString()}</span></div>
  `;

  // Start polling
  startPolling(order_id);
}

// ─── POLL ORDER STATUS ───────────────────────────────────
function startPolling(orderId) {
  if (pollInterval) clearInterval(pollInterval);

  pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/orders/${orderId}`);
      const order = await res.json();

      const dot = document.getElementById('status-dot');
      const text = document.getElementById('status-text');

      if (order.status === 'paid') {
        dot.className = 'status-dot paid';
        text.textContent = '💰 Payment received! Preparing your delivery...';
      }

      if (order.status === 'delivered') {
        dot.className = 'status-dot delivered';
        text.textContent = '✅ Order delivered! Check your Discord DM or email.';
        clearInterval(pollInterval);
        cart = [];
        updateCartUI();
        showToast('✅ Order delivered!');
      }
    } catch (e) {
      // Silently retry
    }
  }, 5000);
}

// ─── UTILS ───────────────────────────────────────────────
function copyVal(elId, btn) {
  const val = document.getElementById(elId)?.textContent;
  if (!val) return;
  navigator.clipboard.writeText(val).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'COPIED';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('copied');
    }, 1800);
  });
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ─── INIT ─────────────────────────────────────────────────
renderProducts();
updateCartUI();

// Close modal on overlay click
document.getElementById('modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
</script>
</body>
</html>
