const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AttendanceLog extends Model {
    static associate(models) {
      AttendanceLog.belongsTo(models.User, {
        foreignKey: 'userId',
        as: 'user',
      });
    }
  }

  AttendanceLog.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'user_id',
      },
      clockInTime: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'clock_in_time',
      },
      clockOutTime: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'clock_out_time',
      },
      shiftDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'shift_date',
      },
      ipAddress: {
        type: DataTypes.STRING,
        allowNull: false,
        field: 'ip_address',
      },
      deviceIdUsed: {
        type: DataTypes.STRING,
        allowNull: false,
        field: 'device_id_used',
      },
      status: {
        type: DataTypes.ENUM('VERIFIED', 'REJECTED', 'ON_LEAVE', 'ABSENT'),
        allowNull: false,
        defaultValue: 'VERIFIED',
      },
      manualStatus: {
        type: DataTypes.STRING(10),
        allowNull: true,
        field: 'manual_status',
      },
      editReason: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'edit_reason',
      },
      editedBy: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'edited_by',
      },
      editedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'edited_at',
      },
      isManual: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'is_manual',
      },
    },
    {
      sequelize,
      modelName: 'AttendanceLog',
      tableName: 'attendance_logs',
      timestamps: true,
    }
  );

  return AttendanceLog;
};
