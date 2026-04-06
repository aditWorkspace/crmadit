const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const password = process.env.DB_PASSWORD;
if (!password) {
  console.error('Usage: DB_PASSWORD=your_password node scripts/migrate.js');
  process.exit(1);
}

const client = new Client({
  host: 'aws-0-us-east-1.pooler.supabase.com',
  port: 5432,
  database: 'postgres',
  user: 'postgres.kwxfsilefratpbzhvcpy',
  password,
  ssl: { rejectUnauthorized: false },
});

const migrations = [
  '001_initial_schema.sql',
  '002_add_contact_info_extracted.sql',
  '003_phase8_gmail.sql',
];

async function run() {
  await client.connect();
  console.log('Connected.');
  for (const file of migrations) {
    const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations', file), 'utf8');
    console.log(`Running ${file}...`);
    await client.query(sql);
    console.log(`  ✓ ${file}`);
  }
  await client.end();
  console.log('\nAll migrations complete!');
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
