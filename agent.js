'use strict';
/*
 * TELUS TSQA — Samsung TV Remote relay AGENT
 * ------------------------------------------------------------------
 * Runs on a team member's own machine. Connects OUTBOUND to the public
 * Fly.io relay and bridges it to the Samsung TV on the LOCAL network,
 * so the hosted remote page (served over HTTPS) can drive a TV that only
 * exposes a self-signed wss://<tv>:8002 endpoint.
 *
 *   Browser ──wss──▶ relay (tizen-remote.fly.dev) ◀──wss── THIS AGENT ──wss──▶ TV:8002
 *
 *   Usage:    node agent.js <TV_IP>
 *   Example:  node agent.js 192.168.1.216
 *   Stop:     Ctrl+C
 *
 * The relay provides valid SSL, so the browser side is plain wss:// with no
 * cert prompts and no mixed-content blocking. This agent talks to the TV with
 * rejectUnauthorized:false (the TV's cert is self-signed) — that is safe because
 * it only ever dials the single TV IP you pass on the command line.
 *
 * Pairing: the first time you connect, the TV shows an on-screen "Allow" prompt.
 * Press Allow once. The agent saves the returned token to a local file next to
 * this script and reuses it on every later connection, so you are never prompted
 * again. The token is NEVER printed or logged.
 */

const fs   = require('fs');
const path = require('path');

// ── Locate the `ws` module: prefer Appium's bundled copy, fall back to local ──
function loadWs() {
  // 1) Explicit / known direct paths (env override + the appium-tizen-tv-driver tree).
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const direct = [
    process.env.WS_MODULE,
    home && path.join(home, '.appium', 'node_modules', 'appium-tizen-tv-driver', 'node_modules', 'ws'),
  ].filter(Boolean);
  for (const c of direct) { try { return require(c); } catch { /* next */ } }

  // 2) Resolve `ws` from Appium's install root, then from this folder / cwd.
  const roots = [];
  try { roots.push(path.dirname(require.resolve('appium'))); } catch { /* appium not resolvable */ }
  if (home) roots.push(path.join(home, '.appium'));
  roots.push(__dirname, process.cwd());
  try { return require(require.resolve('ws', { paths: roots })); } catch { /* next */ }

  // 3) Bare require (works if ws is globally resolvable).
  try { return require('ws'); } catch { /* give up */ }

  console.error('[agent] Could not locate the "ws" module.');
  console.error('[agent] Fix: run  npm install ws  in this folder, or set');
  console.error('[agent] WS_MODULE to a ws install path (e.g. Appium\'s node_modules\\ws).');
  process.exit(1);
}
const WS = loadWs();

// ── Args / config ─────────────────────────────────────────────────────────────
const TV_IP = (process.argv[2] || '').trim();
if (!TV_IP) {
  console.error('Usage: node agent.js <TV_IP>');
  console.error('Example: node agent.js 192.168.1.216');
  process.exit(1);
}
const RELAY_BASE = process.env.RELAY_URL || 'wss://tizen-remote.fly.dev/ws';
const RC_NAME    = Buffer.from('TELUS-TSQA-Remote').toString('base64');  // public app label
const TV_RC_PORT = 8002;
const TOKEN_FILE = path.join(__dirname, '.samsung-rc-token-' + TV_IP.replace(/[^0-9A-Za-z.]/g, '_') + '.json');

const ts = () => new Date().toTimeString().slice(0, 8);
const logI = (m) => console.log('[' + ts() + '] ' + m);

// ── Token persistence (value is never printed) ──────────────────────────────────
function readToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).token || ''; }
  catch { return ''; }
}
function saveToken(tok) {
  if (!tok) return;
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify({ tvIp: TV_IP, token: tok }), { mode: 0o600 }); }
  catch (e) { logI('warn: could not persist token: ' + e.message); }
}

// ── Frame helpers ────────────────────────────────────────────────────────────────
// Samsung's RC socket and the browser BOTH require TEXT frames. ws hands us a
// Buffer (or an array of Buffers for fragmented messages); sending that straight
// through would put a BINARY frame on the wire — the TV silently drops it and the
// browser sees a Blob that JSON.parse can't read (this is the session-018 bug).
// Always coerce to a UTF-8 string.
function toText(d) {
  if (typeof d === 'string') return d;
  if (Buffer.isBuffer(d))    return d.toString('utf8');
  if (Array.isArray(d))      return Buffer.concat(d).toString('utf8');
  return String(d);
}

// ── State ────────────────────────────────────────────────────────────────────────
let relayWs = null;
let tvWs    = null;
let tvOpen  = false;
const queue = [];               // browser->TV frames awaiting the TV socket
let relayBackoff = 1000;        // relay reconnect backoff (ms)
let keepAlive = null;

// ── TV connection ──────────────────────────────────────────────────────────────
// Open (or re-open) a FRESH socket to the TV. We re-open per browser session so
// each new browser receives its own ms.channel.connect (which carries the paired
// state); a long-lived TV socket would have fired that event before the browser
// ever connected, leaving the page stuck on "Connecting…".
function openTv() {
  if (tvWs) { try { tvWs.removeAllListeners(); tvWs.close(); } catch {} }
  tvOpen = false;
  const tok = readToken();
  let url = 'wss://' + TV_IP + ':' + TV_RC_PORT +
    '/api/v2/channels/samsung.remote.control?name=' + RC_NAME;
  if (tok) url += '&token=' + encodeURIComponent(tok);   // omit when blank => TV shows "Allow"

  const sock = new WS(url, { rejectUnauthorized: false });
  tvWs = sock;

  sock.on('open', () => {
    tvOpen = true;
    logI('TV socket open (' + TV_IP + ')' +
      (tok ? ' [reusing saved pairing]' : ' [pairing — press Allow on the TV]'));
    while (queue.length) { try { sock.send(queue.shift()); } catch {} }
  });

  sock.on('message', (d) => {
    const text = toText(d);
    try {
      const j = JSON.parse(text);
      if (j && j.event) logI('TV -> ' + j.event + (j.data && j.data.token ? ' (token received)' : ''));
      if (j && j.event === 'ms.channel.connect' && j.data && j.data.token) saveToken(j.data.token);
    } catch { /* non-JSON frame — relay as-is */ }
    if (relayWs && relayWs.readyState === WS.OPEN) relayWs.send(text);   // TEXT to the browser
  });

  sock.on('close', () => { if (tvWs === sock) tvOpen = false; logI('TV socket closed'); });
  sock.on('error', (e) => logI('TV socket error: ' + e.message));
}

function forwardToTv(text) {
  if (tvOpen && tvWs && tvWs.readyState === WS.OPEN) { try { tvWs.send(text); } catch {} }
  else { queue.push(text); if (!tvWs) openTv(); }
}

function closeTv() {
  if (tvWs) { try { tvWs.removeAllListeners(); tvWs.close(); } catch {} tvWs = null; }
  tvOpen = false;
  queue.length = 0;
}

// ── Relay connection (outbound; auto-reconnect) ─────────────────────────────────
function connectRelay() {
  const url = RELAY_BASE + '?tvIp=' + encodeURIComponent(TV_IP) + '&type=agent';
  logI('connecting to relay…');
  const sock = new WS(url);
  relayWs = sock;

  sock.on('open', () => {
    relayBackoff = 1000;
    logI('connected to relay; bridging TV ' + TV_IP);
    // A browser may already be waiting on the relay — open the TV now so its
    // connect event reaches that browser. A later "hello" re-opens it for a
    // fresh page load.
    openTv();
    clearInterval(keepAlive);
    keepAlive = setInterval(() => { try { sock.ping(); } catch {} }, 30000);
  });

  sock.on('message', (d) => {
    const text = toText(d);
    // Distinguish control frames (e.g. the page's "hello" handshake) from real
    // RC key frames. Control frames carry a `type` and no RC `method` — use them
    // to (re)open a fresh TV socket, and do NOT forward them to the TV.
    try {
      const j = JSON.parse(text);
      if (j && j.type && !j.method) {
        if (j.type === 'hello') logI('browser present — refreshing TV socket');
        openTv();
        return;
      }
    } catch { /* not JSON — treat as an opaque frame for the TV */ }
    forwardToTv(text);
  });

  sock.on('close', () => {
    clearInterval(keepAlive);
    closeTv();
    relayWs = null;
    const delay = relayBackoff;
    relayBackoff = Math.min(relayBackoff * 2, 15000);
    logI('relay disconnected — reconnecting in ' + Math.round(delay / 1000) + 's');
    setTimeout(connectRelay, delay);
  });

  sock.on('error', (e) => logI('relay error: ' + e.message));   // 'close' handles the retry
}

// ── Start ──────────────────────────────────────────────────────────────────────
const BAR = '-'.repeat(48);
console.log(BAR);
console.log('  TELUS TSQA — Samsung Remote Relay Agent');
console.log(BAR);
console.log('  TV IP : ' + TV_IP);
console.log('  Relay : ' + RELAY_BASE);
console.log('  Token : ' + (readToken() ? 'saved (will reuse — no prompt)' : 'none yet (you will press Allow on the TV once)'));
console.log(BAR);
connectRelay();

function shutdown() {
  logI('shutting down…');
  clearInterval(keepAlive);
  closeTv();
  try { if (relayWs) relayWs.close(); } catch {}
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
