module.exports = {
  apps: [{
    name: 'cursor-server',
    script: './src/server.js',
    watch: false,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_memory_restart: '1G',
    node_args: '--experimental-specifier-resolution=node',
    env: {
      NODE_ENV: 'production',
      PORT: 6543
    }
  }]
}; 