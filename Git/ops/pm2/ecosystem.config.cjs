/**
 * PM2 ecosystem for Tonel production.
 * Single source of truth for all server processes — no manual `pm2 start` flags.
 *
 * Apply: `pm2 startOrReload /opt/tonel/ops/ecosystem.config.cjs`
 *
 * Process map (matches nginx + proxy + signaling server expectations):
 *   tonel-signaling       → signaling_server   :9001/TCP
 *   tonel-mixer           → mixer_server       :9002/TCP + :9003/UDP
 *   tonel-ws-proxy        → ws-proxy.js        :9004 (signaling WS + bridge to ws-mixer-proxy)
 *   tonel-ws-mixer-proxy  → ws-mixer-proxy.js  :9005 (mixer WS) + :9006/UDP relay
 *   tonel-wt-mixer-proxy  → wt-mixer-proxy     :4433/UDP (HTTP/3 + WebTransport audio) + :9007/UDP relay
 *
 * WT proxy bypasses nginx — it serves QUIC directly using the
 * srv.tonel.io LetsEncrypt cert. The WSS proxies stay in place as
 * the Safari / older-browser fallback. Web client tries WT first
 * and falls back to WSS automatically when WT is unavailable.
 */

const ROOT = '/opt/tonel'

module.exports = {
  apps: [
    {
      name: 'tonel-signaling',
      script: `${ROOT}/bin/signaling_server`,
      args: '9001',
      cwd: ROOT,
      exec_interpreter: 'none',
      autorestart: true,
      max_restarts: 10,
      out_file: '/var/log/tonel/signaling.out.log',
      error_file: '/var/log/tonel/signaling.err.log',
      merge_logs: true,
    },
    {
      name: 'tonel-mixer',
      script: `${ROOT}/scripts/start-mixer.sh`,
      cwd: ROOT,
      exec_interpreter: 'bash',
      autorestart: true,
      max_restarts: 10,
      out_file: '/var/log/tonel/mixer.out.log',
      error_file: '/var/log/tonel/mixer.err.log',
      merge_logs: true,
    },
    {
      name: 'tonel-ws-proxy',
      script: `${ROOT}/proxy/ws-proxy.js`,
      args: '9004 127.0.0.1 9001',
      cwd: `${ROOT}/proxy`,
      exec_interpreter: 'node',
      autorestart: true,
      max_restarts: 10,
      out_file: '/var/log/tonel/ws-proxy.out.log',
      error_file: '/var/log/tonel/ws-proxy.err.log',
      merge_logs: true,
    },
    {
      name: 'tonel-ws-mixer-proxy',
      script: `${ROOT}/proxy/ws-mixer-proxy.js`,
      args: '9005 127.0.0.1 9002 127.0.0.1 9003 9006',
      cwd: `${ROOT}/proxy`,
      exec_interpreter: 'node',
      autorestart: true,
      max_restarts: 10,
      out_file: '/var/log/tonel/ws-mixer-proxy.out.log',
      error_file: '/var/log/tonel/ws-mixer-proxy.err.log',
      merge_logs: true,
    },
    {
      // WebTransport audio bridge. Listens on UDP :4433 with QUIC,
      // accepts WebTransport sessions at /mixer-wt, forwards SPA1
      // datagrams to the mixer at 127.0.0.1:9003 from a single bound
      // UDP port (9007). The TLS cert is the same LetsEncrypt cert
      // nginx serves for srv.tonel.io. Static Go binary, no runtime
      // deps. Started after the WSS proxy so a fresh deploy never
      // leaves the audio path completely down.
      name: 'tonel-wt-mixer-proxy',
      script: `${ROOT}/bin/wt-mixer-proxy`,
      args: [
        '-listen', ':4433',
        '-cert',   '/etc/letsencrypt/live/srv.tonel.io/fullchain.pem',
        '-key',    '/etc/letsencrypt/live/srv.tonel.io/privkey.pem',
        '-mixer',  '127.0.0.1:9003',
        '-recv',   '9007',
        '-path',   '/mixer-wt',
      ].join(' '),
      cwd: ROOT,
      exec_interpreter: 'none',
      autorestart: true,
      max_restarts: 10,
      out_file: '/var/log/tonel/wt-mixer-proxy.out.log',
      error_file: '/var/log/tonel/wt-mixer-proxy.err.log',
      merge_logs: true,
    },
  ],
}
