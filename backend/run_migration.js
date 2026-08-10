#!/usr/bin/env node
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.app') || process.env.DATABASE_URL?.includes('supabase')
    ? { rejectUnauthorized: false }
    : undefined
});

async function runMigration(sqlFile) {
  const filePath = path.join(__dirname, 'migrations', sqlFile);
  const sql = fs.readFileSync(filePath, 'utf8');

  console.log(`Running migration: ${sqlFile}`);

  try {
    await pool.query(sql);
    console.log('✅ Migration successful');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

// Get migration file from command line argument
const migrationFile = process.argv[2];
if (!migrationFile) {
  console.error('Usage: node run_migration.js <migration_file.sql>');
  process.exit(1);
}

runMigration(migrationFile);
