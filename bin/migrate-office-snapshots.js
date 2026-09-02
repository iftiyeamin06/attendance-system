const { sequelize } = require('../models');

async function migrate() {
  try {
    await sequelize.authenticate();
    console.log('Adding office snapshot columns to attendance_logs...');
    await sequelize.query(`ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS office_start_snapshot VARCHAR(255)`);
    await sequelize.query(`ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS office_end_snapshot VARCHAR(255)`);
    console.log('Migration done. Columns office_start_snapshot, office_end_snapshot ready.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
