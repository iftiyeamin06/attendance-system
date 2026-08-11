require('dotenv').config();
const { User, PasswordReset } = require('../models');

(async () => {
  const stale = await User.findAll({ where: { email: { [require('sequelize').Op.like]: 'pwtest.%' } } });
  for (const u of stale) {
    await PasswordReset.destroy({ where: { userId: u.id } });
    await u.destroy();
    console.log('deleted:', u.email);
  }
  if (!stale.length) console.log('no stale pwtest users');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });