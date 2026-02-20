module.exports = {
  apps: [{
    name: 'whatsapp-claude',
    script: 'index.js',
    cwd: require('path').resolve(require('os').homedir(), 'whatsapp-claude'),
    node_args: '--experimental-vm-modules',
    max_memory_restart: '512M',
    kill_timeout: 5000,
    autorestart: true,
    exp_backoff_restart_delay: 1000,
    max_restarts: 20,
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    time: true,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
