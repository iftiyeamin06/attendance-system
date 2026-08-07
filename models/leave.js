const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Leave extends Model {
    static associate(models) {
      Leave.belongsTo(models.User, {
        foreignKey: 'userId',
        as: 'user',
      });
    }
  }

  Leave.init(
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
      startDate: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        field: 'start_date',
      },
      endDate: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        field: 'end_date',
      },
      leaveType: {
        type: DataTypes.ENUM('sick', 'paid', 'unpaid', 'partial'),
        allowNull: false,
        field: 'leave_type',
      },
      partialHours: {
        type: DataTypes.FLOAT,
        allowNull: true,
        field: 'partial_hours',
      },
      partialFrom: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'partial_from',
      },
      partialTo: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'partial_to',
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'created_by',
      },
    },
    {
      sequelize,
      modelName: 'Leave',
      tableName: 'leaves',
      timestamps: true,
    }
  );

  return Leave;
};
