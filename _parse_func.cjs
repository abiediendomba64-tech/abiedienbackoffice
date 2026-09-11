const { parse } = require('pgsql-parser');
const fs = require('fs');

const filePath = 'supabase/migrations/20260906000005_dashboard_access_and_auth_integrity.sql';
const content = fs.readFileSync(filePath, 'utf8');

// Extract just the function definition (lines 33-50)
const lines = content.split('\n');
const funcLines = lines.slice(32, 50);
const funcDef = funcLines.join('\n');

console.log('=== FUNCTION DEFINITION ===');
console.log(funcDef);
console.log('\n=== PARSING ===');

try {
    const result = parse(funcDef);
    console.log('Parse result:', JSON.stringify(result, null, 2));
} catch (e) {
    console.log('Error:', e.message);
    if (e.sqlDetails) {
        console.log('Cursor position:', e.sqlDetails.cursorPosition);
    }
}

// Try with modified versions
console.log('\n=== TRYING WITHOUT SET search_path ===');
const funcNoSet = funcDef.replace("SET search_path = ''\n", '');
try {
    parse(funcNoSet);
    console.log('OK without SET search_path');
} catch (e) {
    console.log('Error:', e.message);
}

console.log('\n=== TRYING WITH $body$ delimiter ===');
const funcBody = funcDef.replace(/\$\$/g, '$body$');
try {
    parse(funcBody);
    console.log('OK with $body$ delimiter');
} catch (e) {
    console.log('Error:', e.message);
}

console.log('\n=== TRYING WITH search_path = public ===');
const funcPublic = funcDef.replace("SET search_path = ''", "SET search_path = 'public'");
try {
    parse(funcPublic);
    console.log('OK with search_path = public');
} catch (e) {
    console.log('Error:', e.message);
}
