const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class User extends Model {
    static associate(models) {
      User.hasMany(models.AttendanceLog, {
        foreignKey: 'userId',
        as: 'attendanceLogs',
      });
    }

    toJSON() {
      const values = { ...this.get() };
      delete values.password;
      delete values.deviceSecretHash;
      return values;
    }
  }

  User.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
      },
      password: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      role: {
        type: DataTypes.ENUM('admin', 'employee'),
        allowNull: false,
        defaultValue: 'employee',
      },
      boundDeviceId: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'bound_device_id',
      },
      deviceSecretHash: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'device_secret_hash',
      },
      mustChangePassword: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'must_change_password',
      },
      passwordChangedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'password_changed_at',
      },
    },
    {
      sequelize,
      modelName: 'User',
      tableName: 'users',
      timestamps: true,
    }
  );

  return User;
};
