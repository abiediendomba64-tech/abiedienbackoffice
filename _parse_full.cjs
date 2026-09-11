const { parse } = require('pgsql-parser');
const fs = require('fs');

const filePath = 'supabase/migrations/20260906000005_dashboard_access_and_auth_integrity.sql';
const content = fs.readFileSync(filePath, 'utf8');

// Test 1: Original file
console.log('=== TEST 1: Original file ===');
try {
    parse(content);
    console.log('OK - parses successfully');
} catch (e) {
    console.log('ERROR:', e.message);
}

// Test 2: Fix dollar-quote delimiter
console.log('\n=== TEST 2: Fix dollar-quote delimiter ($body$) ===');
const fixed1 = content.replace(/\$\$/g, '$body$');
try {
    parse(fixed1);
    console.log('OK - parses successfully');
} catch (e) {
    console.log('ERROR:', e.message);
}

// Test 3: Fix search_path
console.log('\n=== TEST 3: Fix search_path (remove empty string) ===');
const fixed2 = content.replace("SET search_path = ''", "SET search_path = 'public'");
try {
    parse(fixed2);
    console.log('OK - parses successfully');
} catch (e) {
    console.log('ERROR:', e.message);
}

// Test 4: Both fixes
console.log('\n=== TEST 4: Both fixes ===');
const fixed3 = content.replace(/\$\$/g, '$body$').replace("SET search_path = ''", "SET search_path = 'public'");
try {
    parse(fixed3);
    console.log('OK - parses successfully');
} catch (e) {
    console.log('ERROR:', e.message);
}
