// spa1_wt_client.js — WebTransport-mode Spa1Client for end-to-end audio
// tests against a production-style server (wt-mixer-proxy / QUIC over
// UDP 4433). Mirrors the raw-TCP/UDP and WSS Spa1Client APIs so the
// rest of audio_quality_e2e.js doesn't care which transport is used.
//
// Why this exists: browsers default to WebTransport when available
// (audioService.ts chooseAudioTransport). The user reported 破音 only on
// the WT path on /new, while WSS on /new + WT on / are both clean.
// Loopback A/B and WSS A/B both failed to reproduce — the gap was
// transport coverage. This module fills the WT-path test gap so the
// next "X server is slightly distorted" report can be reproduced
// against a deterministic measurement.
//
// QUIC datagram path:
//   client (this) ──UDP 4433 / QUIC── wt-mixer-proxy ──UDP 9003── mixer
//
// wt-mixer-proxy uses /mixer-wt as the WT path; control is by-passed
// (no separate /mixer-tcp WS) — JOIN happens INSIDE the WT session
// via a SPA1 HANDSHAKE datagram, not a JSON-line ACK exchange. We
// therefore have no control-channel ACK to wait for; we just open the
// WT session, send HANDSHAKE, and start sending audio. The mixer
// implicitly accepts the user when it sees a HANDSHAKE from a new uid.

'use strict';

// @fails-components/webtransport is ESM-only — load via dynamic import
// from the CJS test runner (await'd inside connect()).
// quicheLoaded must resolve before the first WebTransport ctor call,
// otherwise it throws "Lib quiche loading attempt did not end".
let WebTransportCtor = null;
async function loadWT() {
  if (WebTransportCtor) return WebTransportCtor;
  const mod = await import('@fails-components/webtransport');
  await mod.quicheLoaded;
  WebTransportCtor = mod.WebTransport;
  return WebTransportCtor;
}
const WebSocket = require('ws');

const SPA1_HEADER_SIZE = 76;
const SPA1_MAGIC       = 0x53415031;
const CODEC_PCM16      = 0;
const CODEC_HANDSHAKE  = 0xFF;

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

function parseSpa1(buf) {
  if (buf.length < SPA1_HEADER_SIZE) return null;
  if (buf.readUInt32BE(0) !== SPA1_MAGIC) return null;
  return {
    sequence:  buf.readUInt16BE(4),
    timestamp: buf.readUInt16BE(6),
    codec:     buf.readUInt8(72),
    dataSize:  buf.readUInt16BE(73),
    plcFired:  !!(buf.readUInt8(75) & 0x01),
    payload:   buf.slice(SPA1_HEADER_SIZE, SPA1_HEADER_SIZE + buf.readUInt16BE(73)),
  };
}

class Spa1WtClient {
  // host: hostname for https:// URL (e.g. 'srv.tonel.io', 'srv-new.tonel.io')
  // wtPath: WT path on wt-mixer-proxy (default '/mixer-wt')
  // wtPort: UDP port (default 4433)
  // tcpPath: WSS path for MIXER_JOIN control channel (default '/mixer-tcp')
  // Browser architecture is the same: control over WSS, audio over WT.
  // wt-mixer-proxy doesn't see MIXER_JOIN — the mixer registers users by
  // SPA1 HANDSHAKE on the audio path, but the *room state* (passwords,
  // peer list) is owned by the TCP-control path. Without WSS join, the
  // mixer broadcasts to nobody.
  constructor(host, wtPath, wtPort, roomId, userId, tcpPath) {
    this.host       = host;
    this.wtPath     = wtPath || '/mixer-wt';
    this.wtPort     = wtPort || 4433;
    this.tcpPath    = tcpPath || '/mixer-tcp';
    this.roomId     = roomId;
    this.userId     = userId;
    this.userIdKey  = `${roomId}:${userId}`;
    this.tcp        = null;     // WebSocket — control channel (WSS)
    this.wt         = null;     // WebTransport — audio channel
    this.writer     = null;
    this.reader     = null;
    this.readLoop   = null;
    this.sequence   = 0;
    this.onAudio    = null;
  }

  async connect() {
    // 1. WSS control — MIXER_JOIN + ACK ───────────────────────────────
    const tcpUrl = `wss://${this.host}${this.tcpPath}`;
    this.tcp = new WebSocket(tcpUrl);
    await once(this.tcp, 'open');
    const joinAcked = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MIXER_JOIN ack timeout')), 5000);
      let acc = '';
      const onMsg = (data) => {
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
    this.tcp.on('message', () => {});

    // 2. WT audio session ─────────────────────────────────────────────
    const WT = await loadWT();
    const url = `https://${this.host}:${this.wtPort}${this.wtPath}`;
    this.wt = new WT(url);
    await this.wt.ready;

    // Datagrams writable + readable.
    this.writer = this.wt.datagrams.writable.getWriter();
    this.reader = this.wt.datagrams.readable.getReader();

    // Background read loop — every datagram is one SPA1 packet from
    // the mixer broadcast. Push to onAudio.
    this.readLoop = (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
          const pkt = parseSpa1(buf);
          if (!pkt || pkt.codec !== CODEC_PCM16 || pkt.dataSize === 0) continue;
          if (this.onAudio) this.onAudio(pkt.payload, pkt);
        }
      } catch (_e) {
        // Reader closed — normal teardown path.
      }
    })();

    // SPA1 HANDSHAKE — registers this uid with the mixer.
    const hs = encodeSpa1(0, 0, this.userIdKey, CODEC_HANDSHAKE, Buffer.alloc(0));
    await this.writer.write(new Uint8Array(hs));
  }

  sendPcm16(pcmBuf) {
    const ts  = Date.now() & 0xFFFF;
    const pkt = encodeSpa1(this.sequence++ & 0xFFFF, ts, this.userIdKey, CODEC_PCM16, pcmBuf);
    // datagram writes can block on flow control; we don't await here
    // for throughput, the @fails-components implementation queues
    // internally if the QUIC congestion window is full. Errors land
    // on the read loop via session close.
    this.writer.write(new Uint8Array(pkt)).catch(() => {});
  }

  async close() {
    try { await this.writer?.close(); } catch (_) {}
    try { this.reader?.cancel(); } catch (_) {}
    try { this.wt?.close(); } catch (_) {}
    try { this.tcp?.close(); } catch (_) {}
  }
}

function once(emitter, ev) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { emitter.removeListener(ev, onOk); reject(e); };
    const onOk  = (v) => { emitter.removeListener('error', onErr); resolve(v); };
    emitter.once(ev, onOk);
    emitter.once('error', onErr);
  });
}

module.exports = { Spa1WtClient };
