const { sequelize } = require('../models');

async function run() {
  try {
    const queryInterface = sequelize.getQueryInterface();
    const table = await queryInterface.describeTable('attendance_logs');
    if (!table.shift_date) {
      await queryInterface.addColumn('attendance_logs', 'shift_date', {
        type: sequelize.Sequelize.DATEONLY,
        allowNull: true,
      });
      console.log('Added shift_date column.');
    } else {
      console.log('shift_date column already exists.');
    }
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
}

run();
