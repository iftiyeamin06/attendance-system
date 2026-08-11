const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AuditLog extends Model {
    static associate(models) {
      AuditLog.belongsTo(models.User, {
        foreignKey: 'adminId',
        as: 'admin',
        constraints: false,
      });
      AuditLog.belongsTo(models.User, {
        foreignKey: 'targetUserId',
        as: 'targetUser',
        constraints: false,
      });
    }
  }

  AuditLog.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      adminId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'admin_id',
      },
      action: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      targetUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'target_user_id',
      },
      details: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'AuditLog',
      tableName: 'audit_logs',
      timestamps: true,
      updatedAt: false,
    }
  );

  return AuditLog;
};