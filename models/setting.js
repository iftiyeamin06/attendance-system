const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Setting extends Model {
    static associate(models) {
      // Settings model has no direct associations
    }
  }

  Setting.init(
    {
      key: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        primaryKey: true,
      },
      value: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'Setting',
      tableName: 'settings',
      timestamps: false,
    }
  );

  return Setting;
};
