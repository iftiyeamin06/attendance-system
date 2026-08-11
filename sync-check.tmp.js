const { sequelize, AttendanceLog } = require('./models');

(async () => {
  await sequelize.authenticate();
  const before = await sequelize.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='attendance_logs' ORDER BY ordinal_position"
  );
  console.log('BEFORE:', before[0].map((c) => c.column_name).join(', '));

  await AttendanceLog.sync({ force: false });

  const after = await sequelize.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='attendance_logs' ORDER BY ordinal_position"
  );
  console.log('AFTER:', after[0].map((c) => c.column_name).join(', '));

  const has = after[0].some((c) => c.column_name === 'manual_status');
  if (!has) {
    await sequelize.query(
      'ALTER TABLE attendance_logs ADD COLUMN manual_status VARCHAR(10), ADD COLUMN edit_reason TEXT, ADD COLUMN edited_by TEXT, ADD COLUMN edited_at TIMESTAMPTZ, ADD COLUMN is_manual BOOLEAN NOT NULL DEFAULT FALSE'
    );
    console.log('Added columns manually via ALTER TABLE.');
  }
  process.exit(0);
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});