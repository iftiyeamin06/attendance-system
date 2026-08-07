const { sequelize, User, Setting } = require('../models');

(async () => {
  try {
    await sequelize.authenticate();
    const users = await User.findAll();
    console.log('=== ALL USERS IN DATABASE ===');
    users.forEach((u) => {
      console.log(`- ${u.email} | role: ${u.role} | id: ${u.id}`);
    });

    console.log('\n=== SETTINGS ===');
    const settings = await Setting.findAll();
    settings.forEach((s) => console.log(`- ${s.key} = ${s.value}`));

    console.log('\n=== CHECK EMPLOYEE LOGIN ===');
    const emp = await User.findOne({ where: { email: 'employee@attendance.local' } });
    if (emp) {
      console.log('Employee found:', emp.email, '| role:', emp.role);
      console.log('Is admin?', emp.role === 'admin' ? 'YES - THIS IS THE BUG' : 'No');
    } else {
      console.log('Employee NOT FOUND in database!');
    }

    await sequelize.close();
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
