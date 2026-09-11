const { parse } = require('pgsql-parser');
const fs = require('fs');

const filePath = 'supabase/migrations/20260906000005_dashboard_access_and_auth_integrity.sql';
const content = fs.readFileSync(filePath, 'utf8');

// Find what's at cursor position 402
console.log('=== CONTENT AROUND POSITION 402 ===');
console.log('Characters 390-420:');
console.log(JSON.stringify(content.substring(390, 420)));
console.log('');

// Try parsing incrementally to find the exact failure point
console.log('=== INCREMENTAL PARSE ===');
const lines = content.split('\n');
let accumulated = '';
let lastSuccessLine = 0;

for (let i = 0; i < lines.length; i++) {
    accumulated += lines[i] + '\n';
    try {
        parse(accumulated);
        lastSuccessLine = i + 1;
    } catch (e) {
        console.log(`\nFirst error at line ${i + 1}: "${lines[i].trim()}"`);
        console.log(`Error: ${e.message}`);
        console.log(`Last successful parse ended at line ${lastSuccessLine}`);
        
        // Show context around the error
        console.log('\n--- Context (lines ' + Math.max(1, i-3) + ' to ' + (i+2) + ') ---');
        for (let j = Math.max(0, i-4); j <= Math.min(lines.length-1, i+2); j++) {
            const marker = j === i ? ' >>> ' : '     ';
            console.log(`${marker}Line ${j+1}: ${lines[j]}`);
        }
        break;
    }
}

// Also try parsing just the first statement
console.log('\n=== PARSING FIRST STATEMENT ONLY ===');
const firstSemicolon = content.indexOf(';\n');
if (firstSemicolon > 0) {
    const firstStmt = content.substring(0, firstSemicolon + 1);
    try {
        parse(firstStmt);
        console.log('First statement parses OK');
    } catch (e) {
        console.log('First statement error:', e.message);
    }
}
