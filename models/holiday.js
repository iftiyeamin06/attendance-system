const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Holiday extends Model {
    static associate(models) {}
  }

  Holiday.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        unique: true,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
    },
    {
      sequelize,
      modelName: 'Holiday',
      tableName: 'holidays',
      timestamps: true,
    }
  );

  return Holiday;
};