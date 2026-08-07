// scripts/migrate-to-supabase.js
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const { Sequelize } = require('sequelize');
const { User, Setting, AttendanceLog, Leave } = require('../models');

async function testSupabaseConnection() {
  try {
    await User.findAll({ limit: 1 });
    console.log('✅ Supabase connection successful');
    return true;
  } catch (error) {
    console.error('❌ Supabase connection failed:', error.message);
    return false;
  }
}

async function getSQLiteData() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database('./database.sqlite');
    const data = {};
    
    const queries = {
      users: 'SELECT * FROM users',
      settings: 'SELECT * FROM settings',
      attendance_logs: 'SELECT * FROM attendance_logs',
      leaves: 'SELECT * FROM leaves'
    };
    
    let completedQueries = 0;
    const totalQueries = Object.keys(queries).length;
    
    Object.keys(queries).forEach((table) => {
      db.all(queries[table], (err, rows) => {
        if (err) {
          console.error(`Error querying ${table}:`, err);
          reject(err);
          return;
        }
        data[table] = rows;
        completedQueries++;
        
        if (completedQueries === totalQueries) {
          db.close();
          resolve(data);
        }
      });
    });
  });
}

async function migrateData() {
  console.log('🚀 Starting migration to Supabase...');
  
  // Test Supabase connection first
  const connectionOk = await testSupabaseConnection();
  if (!connectionOk) {
    console.log('❌ Cannot proceed with migration. Check Supabase connection.');
    console.log('Make sure DATABASE_URL is set correctly in .env file');
    process.exit(1);
  }
  
  // Check if Supabase is empty
  const usersCount = await User.count();
  const logsCount = await AttendanceLog.count();
  const leavesCount = await Leave.count();
  const settingsCount = await Setting.count();
  
  console.log('Current Supabase data:');
  console.log(`  Users: ${usersCount}`);
  console.log(`  Attendance Logs: ${logsCount}`);
  console.log(`  Leaves: ${leavesCount}`);
  console.log(`  Settings: ${settingsCount}`);
  
  // Get SQLite data
  console.log('\n📊 Reading SQLite database...');
  const sqliteData = await getSQLiteData();
  
  if (!sqliteData) {
    console.log('❌ Failed to read SQLite data');
    process.exit(1);
  }
  
  console.log('\n📈 Data Summary:');
  Object.keys(sqliteData).forEach((table) => {
    console.log(`  ${table}: ${sqliteData[table].length} rows`);
  });
  
  // Clear existing Supabase data
  console.log('\n🧹 Clearing existing Supabase data...');
  await AttendanceLog.destroy({ where: {}, force: true });
  await Leave.destroy({ where: {}, force: true });
  await User.destroy({ where: {}, force: true });
  await Setting.destroy({ where: {}, force: true });
  
  // Migrate SQLite data to Supabase
  console.log('\n⬆️  Migrating data to Supabase...');
  
  try {
    // Insert in dependency order (users -> settings -> attendance_logs -> leaves)
    console.log('Inserting Users...');
    await User.bulkCreate(sqliteData.users);
    
    console.log('Inserting Settings...');
    await Setting.bulkCreate(sqliteData.settings);
    
    console.log('Inserting Attendance Logs...');
    await AttendanceLog.bulkCreate(sqliteData.attendance_logs);
    
    console.log('Inserting Leaves...');
    await Leave.bulkCreate(sqliteData.leaves);
    
    console.log('\n✅ Migration completed successfully!');
    
    // Verify migration
    const finalCounts = {
      users: await User.count(),
      settings: await Setting.count(),
      attendance_logs: await AttendanceLog.count(),
      leaves: await Leave.count()
    };
    
    console.log('\n📊 Migration Verification:');
    Object.keys(finalCounts).forEach((table) => {
      const sqliteCount = sqliteData[table].length;
      const supabaseCount = finalCounts[table];
      console.log(`  ${table}: SQLite=${sqliteCount}, Supabase=${supabaseCount} ${sqliteCount === supabaseCount ? '✅' : '❌'}`);
    });
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    console.error('\n💡 Common causes:');
    console.error('   - Database connection issues');
    console.error('   - Data type mismatches');
    console.error('   - Foreign key constraint violations');
    process.exit(1);
  }
}

if (require.main === module) {
  migrateData().catch(console.error);
}