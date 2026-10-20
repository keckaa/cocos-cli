const fs = require('fs');
const path = require('path');

// Unix uses the executable bit for npm's `bin` entry. TypeScript emits files
// with a regular-file mode, so restore the bit after generating dist/cli.js.
if (process.platform !== 'win32') {
    const cliPath = path.join(__dirname, '..', 'dist', 'cli.js');

    if (!fs.existsSync(cliPath)) {
        throw new Error(`CLI build output is missing: ${cliPath}`);
    }

    const mode = fs.statSync(cliPath).mode;
    fs.chmodSync(cliPath, mode | 0o111);
}
