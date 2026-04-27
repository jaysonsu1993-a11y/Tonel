/**
 * PM2 ecosystem for Tonel production.
 * Single source of truth for all server processes — no manual `pm2 start` flags.
 *
 * Apply: `pm2 startOrReload /opt/tonel/ops/ecosystem.config.cjs`
 *
 * Process map (matches nginx + ws-mixer-proxy + signaling server expectations):
 *   tonel-signaling       → signaling_server :9001/TCP
 *   tonel-mixer           → mixer_server     :9002/TCP + :9003/UDP
 *   tonel-ws-proxy        → ws-proxy.js      :9004 (signaling WS + bridge to ws-mixer-proxy)
 *   tonel-ws-mixer-proxy  → ws-mixer-proxy.js :9005 (mixer WS) + :9006/UDP relay
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
  ],
}
