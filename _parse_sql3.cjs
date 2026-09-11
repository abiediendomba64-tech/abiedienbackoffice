const { parse } = require('pgsql-parser');
const fs = require('fs');

const filePath = 'supabase/migrations/20260906000005_dashboard_access_and_auth_integrity.sql';
const content = fs.readFileSync(filePath, 'utf8');

// Split by semicolons to get individual statements
const statements = content.split(';').filter(s => s.trim().length > 0);

console.log(`Found ${statements.length} statements\n`);

statements.forEach((stmt, i) => {
    const firstLine = stmt.trim().split('\n')[0].substring(0, 60);
    try {
        const result = parse(stmt);
        if (result.query && result.query.length > 0) {
            console.log(`Statement ${i + 1}: OK - "${firstLine}..."`);
        } else if (result.error) {
            console.log(`Statement ${i + 1}: ERROR - "${firstLine}..."`);
            console.log(`  Error: ${result.error.message}`);
        } else {
            console.log(`Statement ${i + 1}: UNKNOWN - "${firstLine}..."`);
        }
    } catch (e) {
        console.log(`Statement ${i + 1}: EXCEPTION - "${firstLine}..."`);
        console.log(`  Exception: ${e.message}`);
        if (e.sqlDetails) {
            console.log(`  Cursor position: ${e.sqlDetails.cursorPosition}`);
            // Show context around cursor
            const pos = e.sqlDetails.cursorPosition;
            const start = Math.max(0, pos - 30);
            const end = Math.min(stmt.length, pos + 30);
            console.log(`  Context: ..."${stmt.substring(start, end)}..."`);
        }
    }
});
