/* DEV/CI ONLY. Inserts identifiable synthetic supplier fixtures; never resets data. */
const { Pool } = require('pg');
async function bootstrap() {
  if (process.env.NODE_ENV === 'production') throw new Error('Web fixtures are for development/CI only');
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost', port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || 'smartprocure_db',
    user: process.env.POSTGRES_USER || 'smartprocure_user', password: process.env.POSTGRES_PASSWORD || 'postgres_password',
  });
  try {
    await pool.query(`INSERT INTO suppliers(supplier_code, tax_code, name, status)
      VALUES ('WEB-E2E-ACTIVE', 'WEB-E2E-TAX-ACTIVE', 'WEB E2E Synthetic Office Supplier', 'ACTIVE'),
             ('WEB-E2E-BLOCKED', 'WEB-E2E-TAX-BLOCKED', 'WEB E2E Synthetic Blocked Supplier', 'BLOCKED')
      ON CONFLICT (supplier_code) DO NOTHING`);
    console.log('Synthetic WEB-E2E supplier fixtures available; existing records retained.');
  } finally { await pool.end(); }
}
bootstrap().catch(error => { console.error(error.message); process.exitCode = 1; });
