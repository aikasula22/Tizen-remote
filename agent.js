// Samsung TV Agent - runs on user's machine
// Connects outbound to relay, forwards to local TV
'use strict';

const WebSocket = require('ws');

const RELAY_URL = process.env.RELAY_URL || 
  'wss://tizen-remote.fly.dev';
const TV_IP = process.argv[2] || '192.168.1.1';
const TV_PORT = 8002;
const AUTH = Buffer.from('tsqa:tsqa').toString('base64');
const APP_NAME = Buffer.from('Tizen Remote').toString('base64');

console.log(`Samsung TV Agent`);
console.log(`TV: ${TV_IP}:${TV_PORT}`);
console.log(`Relay: ${RELAY_URL}`);
console.log(`Connecting...`);

function connect() {
  // Connect to relay
  const relay = new WebSocket(
    `${RELAY_URL}/ws?type=agent&tvIp=${TV_IP}`,
    { headers: { Authorization: `Basic ${AUTH}` } }
  );

  relay.on('open', () => {
    console.log(`Connected to relay ✓`);
    connectToTV(relay);
  });

  relay.on('close', () => {
    console.log(`Relay disconnected. Reconnecting in 3s...`);
    setTimeout(connect, 3000);
  });

  relay.on('error', (e) => {
    console.log(`Relay error: ${e.message}`);
  });
}

function connectToTV(relay) {
  const tvUrl = `wss://${TV_IP}:${TV_PORT}/api/v2/channels/` +
    `samsung.remote.control?name=${APP_NAME}`;

  const tv = new WebSocket(tvUrl, { rejectUnauthorized: false });

  tv.on('open', () => {
    console.log(`Connected to TV ✓`);
    console.log(`Ready! Open the remote and enter ${TV_IP}`);
  });

  tv.on('message', (data) => {
    if (relay.readyState === WebSocket.OPEN) {
      relay.send(typeof data === 'string' ? 
        data : data.toString('utf8'));
    }
  });

  relay.on('message', (data) => {
    if (tv.readyState === WebSocket.OPEN) {
      tv.send(typeof data === 'string' ? 
        data : data.toString('utf8'));
    }
  });

  tv.on('close', () => {
    console.log(`TV disconnected. Reconnecting...`);
    setTimeout(() => connectToTV(relay), 2000);
  });

  tv.on('error', (e) => {
    console.log(`TV error: ${e.message}`);
  });
}

connect();
