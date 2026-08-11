const { Sequelize } = require('sequelize');
const env = process.env.NODE_ENV || 'development';
const config = require(__dirname + '/../config/database.js')[env];

let sequelize;
if (config.url) {
  sequelize = new Sequelize(config.url, {
    ...config,
    logging: config.logging,
  });
} else {
  sequelize = new Sequelize(config.database, config.username, config.password, config);
}

const db = {};

db.sequelize = sequelize;
db.Sequelize = Sequelize;

db.User = require('./user')(sequelize, Sequelize.DataTypes);
db.Setting = require('./setting')(sequelize, Sequelize.DataTypes);
db.AttendanceLog = require('./attendanceLog')(sequelize, Sequelize.DataTypes);
db.Leave = require('./leave')(sequelize, Sequelize.DataTypes);
db.PasswordReset = require('./passwordReset')(sequelize, Sequelize.DataTypes);

Object.keys(db).forEach((modelName) => {
  if (db[modelName] && typeof db[modelName].associate === 'function') {
    db[modelName].associate(db);
  }
});

module.exports = db;
