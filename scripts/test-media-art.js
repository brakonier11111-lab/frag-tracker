const fs = require('fs');
const { spawn } = require('child_process');
const exe = process.argv[2];
const p = spawn(exe, [], { stdio: ['ignore', 'pipe', 'pipe'] });
const chunks = [];
p.stdout.on('data', (c) => chunks.push(c));
p.on('close', (code) => {
    const buf = Buffer.concat(chunks);
    const nl = buf.indexOf(10);
    const ct = buf.slice(0, nl).toString();
    const img = buf.slice(nl + 1);
    console.log('exit', code, 'ct', ct, 'bytes', img.length);
    if (img.length > 100) {
        fs.writeFileSync(require('path').join(__dirname, 'test-art.jpg'), img);
    }
});
