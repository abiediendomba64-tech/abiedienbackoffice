const fs = require('fs');
const filePath = 'supabase/migrations/20260906000005_dashboard_access_and_auth_integrity.sql';
const buf = fs.readFileSync(filePath);

// Show hex dump of line 13 area (lines 10-17)
let lineNum = 1;
let lineStart = 0;
const targetLines = [10, 11, 12, 13, 14, 15, 16, 17];

for (let i = 0; i < buf.length && lineNum <= 17; i++) {
    if (buf[i] === 0x0A || i === buf.length - 1) {
        if (targetLines.includes(lineNum)) {
            const lineBuf = buf.slice(lineStart, buf[i] === 0x0A ? i : i + 1);
            const hex = Array.from(lineBuf).map(b => b.toString(16).padStart(2, '0')).join(' ');
            const ascii = Array.from(lineBuf).map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
            console.log(`Line ${lineNum} (${lineBuf.length} bytes):`);
            console.log(`  HEX:  ${hex}`);
            console.log(`  ASCII: ${ascii}`);
        }
        lineNum++;
        lineStart = i + 1;
    }
}

// Also check for BOM
console.log('\n=== BOM CHECK ===');
if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    console.log('UTF-8 BOM detected at start of file');
} else {
    console.log('No UTF-8 BOM detected');
}

// Check line endings
console.log('\n=== LINE ENDING CHECK ===');
let crlfCount = 0;
let lfCount = 0;
for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0D && buf[i + 1] === 0x0A) {
        crlfCount++;
        i++;
    } else if (buf[i] === 0x0A) {
        lfCount++;
    }
}
console.log(`CRLF line endings: ${crlfCount}`);
console.log(`LF line endings: ${lfCount}`);
