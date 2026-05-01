// spa1_wss_client.js — WSS-mode Spa1Client for end-to-end audio tests
// against a remote production-style server (nginx → ws-mixer-proxy →
// mixer). Mirrors the raw-TCP/UDP Spa1Client API in audio_quality_e2e.js
// so callers can swap transports without changing the rest of the test.
//
// The two paths exposed by ws-mixer-proxy.js:
//   /mixer-tcp  — newline-terminated JSON (MIXER_JOIN, ACK, LEVELS, ...)
//   /mixer-udp  — SPA1 binary frames in both directions
//
// Why this exists: the raw test client connects to mixer's 9002/9003
// directly. Production hides those behind UFW; only WSS on 443 is
// exposed. Comparing servers from one operator vantage point requires
// hitting the same WSS path the browser hits — that path also carries
// the WSS-over-TCP burst characteristics that the v1.0.38 jitter-cap
// fix targeted, so the test path matches the symptom path.

'use strict';

const WebSocket = require('ws');

const SPA1_HEADER_SIZE = 76;
const SPA1_MAGIC       = 0x53415031;
const CODEC_PCM16      = 0;
const CODEC_HANDSHAKE  = 0xFF;

// (encodeSpa1 / parseSpa1 are duplicated from audio_quality_e2e.js to
// keep this module self-contained — the test file imports the same
// helpers locally. Kept short.)
function encodeSpa1(sequence, timestamp, userIdKey, codec, payload) {
  const out = Buffer.alloc(SPA1_HEADER_SIZE + payload.length);
  out.writeUInt32BE(SPA1_MAGIC, 0);
  out.writeUInt16BE(sequence & 0xFFFF, 4);
  out.writeUInt16BE(timestamp & 0xFFFF, 6);
  out.write(userIdKey, 8, Math.min(63, userIdKey.length), 'utf8');
  out.writeUInt8(codec, 72);
  out.writeUInt16BE(payload.length, 73);
  out.writeUInt8(0, 75);
  payload.copy(out, SPA1_HEADER_SIZE);
  return out;
}

class Spa1WssClient {
  // host: hostname for wss:// URLs (e.g. 'srv.tonel.io', 'srv-new.tonel.io')
  // tcpPath: path to /mixer-tcp endpoint (default '/mixer-tcp')
  // udpPath: path to /mixer-udp endpoint (default '/mixer-udp')
  constructor(host, tcpPath, udpPath, roomId, userId) {
    this.host       = host;
    this.tcpPath    = tcpPath || '/mixer-tcp';
    this.udpPath    = udpPath || '/mixer-udp';
    this.roomId     = roomId;
    this.userId     = userId;
    this.userIdKey  = `${roomId}:${userId}`;
    this.tcp        = null;     // WebSocket — control channel
    this.udp        = null;     // WebSocket — audio channel
    this.sequence   = 0;
    this.onAudio    = null;     // (Buffer payload, parsedPkt) => void
  }

  async connect() {
    // 1. Control WS — open + MIXER_JOIN + wait for ACK ────────────────
    const tcpUrl = `wss://${this.host}${this.tcpPath}`;
    this.tcp = new WebSocket(tcpUrl);
    await once(this.tcp, 'open');

    const joinAcked = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MIXER_JOIN ack timeout')), 5000);
      let acc = '';
      const onMsg = (data) => {
        // ws-mixer-proxy forwards the mixer's TCP newline-delimited
        // JSON as text frames (or buffer if binary). Concatenate until
        // we see a line containing 'ACK'.
        acc += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        let nl;
        while ((nl = acc.indexOf('\n')) !== -1) {
          const line = acc.slice(0, nl);
          acc = acc.slice(nl + 1);
          if (line.includes('ACK')) {
            clearTimeout(timer);
            this.tcp.removeListener('message', onMsg);
            resolve();
            return;
          }
        }
      };
      this.tcp.on('message', onMsg);
    });

    this.tcp.send(`{"type":"MIXER_JOIN","room_id":"${this.roomId}","user_id":"${this.userId}"}\n`);
    await joinAcked;
    // After ACK, drain further messages so the proxy doesn't backpressure.
    this.tcp.on('message', () => {});

    // 2. Audio WS — open ──────────────────────────────────────────────
    const udpUrl = `wss://${this.host}${this.udpPath}`;
    this.udp = new WebSocket(udpUrl);
    await once(this.udp, 'open');

    this.udp.on('message', (msg) => {
      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      const pkt = parseSpa1Local(buf);
      if (!pkt || pkt.codec !== CODEC_PCM16 || pkt.dataSize === 0) return;
      if (this.onAudio) this.onAudio(pkt.payload, pkt);
    });

    // 3. SPA1 HANDSHAKE — registers our return-path with the proxy's
    // wsByUid map (proxy uses the SPA1 userId field to route the
    // mixer's broadcast back to the right WS).
    const hs = encodeSpa1(0, 0, this.userIdKey, CODEC_HANDSHAKE, Buffer.alloc(0));
    this.udp.send(hs, { binary: true });
  }

  sendPcm16(pcmBuf) {
    const ts  = Date.now() & 0xFFFF;
    const pkt = encodeSpa1(this.sequence++ & 0xFFFF, ts, this.userIdKey, CODEC_PCM16, pcmBuf);
    this.udp.send(pkt, { binary: true });
  }

  close() {
    if (this.udp) try { this.udp.close(); } catch (_) {}
    if (this.tcp) try { this.tcp.close(); } catch (_) {}
  }
}

// Local copy of parseSpa1 — same layout audio_quality_e2e.js parses.
// Includes the plcFired bit from byte 75 (mixer flags PLC ticks via
// `reserved & 0x01`; production clients ignore it, the test reads it).
function parseSpa1Local(buf) {
  if (buf.length < SPA1_HEADER_SIZE) return null;
  const magic = buf.readUInt32BE(0);
  if (magic !== SPA1_MAGIC) return null;
  const sequence  = buf.readUInt16BE(4);
  const timestamp = buf.readUInt16BE(6);
  const codec     = buf.readUInt8(72);
  const dataSize  = buf.readUInt16BE(73);
  const reserved  = buf.readUInt8(75);
  const payload   = buf.slice(SPA1_HEADER_SIZE, SPA1_HEADER_SIZE + dataSize);
  return { sequence, timestamp, codec, dataSize, plcFired: !!(reserved & 0x01), payload };
}

function once(emitter, ev) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { emitter.removeListener(ev, onOk); reject(e); };
    const onOk  = (v) => { emitter.removeListener('error', onErr); resolve(v); };
    emitter.once(ev, onOk);
    emitter.once('error', onErr);
  });
}

module.exports = { Spa1WssClient };
