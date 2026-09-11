const { parse } = require('pgsql-parser');
const fs = require('fs');

const filePath = 'supabase/migrations/20260906000005_dashboard_access_and_auth_integrity.sql';
const content = fs.readFileSync(filePath, 'utf8');

console.log('Attempting to parse the migration SQL...\n');

try {
    const result = parse(content);
    console.log('Parse SUCCESS - no syntax errors found by pgsql-parser');
    console.log('Number of statements parsed:', result.length);
    result.forEach((stmt, i) => {
        const type = stmt.stmt ? Object.keys(stmt.stmt)[0] : 'unknown';
        console.log(`  Statement ${i + 1}: ${type}`);
    });
} catch (err) {
    console.log('Parse ERROR:');
    console.log(err.message);
    
    // Try to parse line by line to find the exact error location
    console.log('\n--- Trying to locate the error ---');
    const lines = content.split('\n');
    let accumulated = '';
    
    for (let i = 0; i < lines.length; i++) {
        accumulated += lines[i] + '\n';
        try {
            parse(accumulated);
        } catch (e) {
            console.log(`Error detected at line ${i + 1}: "${lines[i].trim()}"`);
            console.log(`Parser error: ${e.message}`);
            
            // Try to find which statement boundary we're at
            const lastSemicolon = accumulated.lastIndexOf(';\n');
            if (lastSemicolon > 0) {
                const afterLastSemicolon = accumulated.substring(lastSemicolon + 2);
                console.log(`Content after last semicolon:`);
                console.log(afterLastSemicolon.substring(0, 200));
            }
            break;
        }
    }
}
