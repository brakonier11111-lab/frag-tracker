const { spawn } = require('child_process');
const path = require('path');

console.log('Starting server...');

const serverPath = path.join(__dirname, 'server.js');
const server = spawn('node', [serverPath], {
    stdio: 'inherit',
    cwd: __dirname
});

server.on('error', (err) => {
    console.error('Failed to start server:', err);
});

server.on('close', (code) => {
    console.log(`Server exited with code ${code}`);
});

process.on('SIGINT', () => {
    console.log('Stopping server...');
    server.kill('SIGINT');
    process.exit(0);
});



