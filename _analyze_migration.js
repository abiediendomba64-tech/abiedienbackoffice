const fs = require('fs');
const filePath = 'supabase/migrations/20260906000005_dashboard_access_and_auth_integrity.sql';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('=== FILE ANALYSIS ===');
console.log('Total lines:', lines.length);
console.log('File size:', content.length, 'bytes');

// Check for non-ASCII characters
console.log('\n=== NON-ASCII CHARACTER CHECK ===');
let foundNonAscii = false;
lines.forEach((line, i) => {
    const nonAscii = [...line].filter(ch => ch.charCodeAt(0) > 127);
    if (nonAscii.length > 0) {
        foundNonAscii = true;
        console.log(`Line ${i + 1}: ${JSON.stringify(nonAscii)}`);
    }
});
if (!foundNonAscii) console.log('No non-ASCII characters found.');

// Check parentheses balance
console.log('\n=== PARENTHESES BALANCE CHECK ===');
let depth = 0;
let hasError = false;
lines.forEach((line, i) => {
    for (const ch of line) {
        if (ch === '(') depth++;
        if (ch === ')') {
            depth--;
            if (depth < 0) {
                console.log(`Line ${i + 1}: UNBALANCED - closing ) without opening (`);
                console.log(`  Content: ${line.trim()}`);
                hasError = true;
            }
        }
    }
});
if (!hasError) console.log('No unbalanced parentheses found.');
console.log('Final parenthesis depth:', depth);

// Show line 13 context
console.log('\n=== LINE 13 CONTEXT ===');
for (let i = 10; i <= 17; i++) {
    if (lines[i]) {
        console.log(`Line ${i + 1}: ${lines[i]}`);
    }
}

// Show all lines with ) on or near line 13
console.log('\n=== LINES WITH ) CHARACTER ===');
lines.forEach((line, i) => {
    if (line.includes(')')) {
        console.log(`Line ${i + 1}: ${line.trim()}`);
    }
});
