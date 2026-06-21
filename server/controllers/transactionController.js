import Transaction from '../models/Transaction.js';
import Account from '../models/Account.js';
import mongoose from 'mongoose';
import moment from 'moment-timezone';

// @desc    Add a new transaction
// @route   POST /api/transactions
// @access  Private
const addTransaction = async (req, res) => {
  const { description, amount, type, category, date, account: accountId } = req.body;
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const account = await Account.findById(accountId).session(session);
    if (!account || account.user.toString() !== req.user._id.toString()) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Account not found or not authorized' });
    }
    const correctDate = moment.tz(date, "Asia/Kolkata").toDate();

    const transaction = new Transaction({
      user: req.user._id,
      account: accountId,
      description,
      amount: Number(amount),
      type,
      category,
      date: correctDate,
    });
    
    // Update account balance
    if (type === 'income') {
      account.balance += Number(amount);
    } else { // 'expense'
      account.balance -= Number(amount);
    }

    await account.save({ session });
    const createdTransaction = await transaction.save({ session });
    
    await session.commitTransaction();
    res.status(201).json(createdTransaction);
  } catch (error) {
    await session.abortTransaction();
    console.error("Add Transaction Error:", error);
    res.status(500).json({ message: 'Server Error' });
  } finally {
    session.endSession();
  }
};

// @desc    Get transactions with filtering and pagination
// @route   GET /api/transactions
// @access  Private
const getTransactions = async (req, res) => {
  const { page = 1, limit = 10, description, category, account } = req.query;
  try {
    const query = { user: req.user._id };
    
    if (description) {
      query.description = { $regex: description, $options: 'i' };
    }
    if (category) {
      query.category = category;
    }
    if (account) {
      query.account = account;
    }

    const transactions = await Transaction.find(query)
      .populate('account', 'name type')
      .sort({ date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();
    
    const count = await Transaction.countDocuments(query);

    res.json({
      transactions,
      totalPages: Math.ceil(count / limit),
      currentPage: Number(page),
    });
  } catch (error) {
    res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Update a transaction
// @route   PUT /api/transactions/:id
// @access  Private
const updateTransaction = async (req, res) => {
  const { description, amount, type, category, date, account: accountId } = req.body;
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const transaction = await Transaction.findById(req.params.id).session(session);
    if (!transaction || transaction.user.toString() !== req.user._id.toString()) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Transaction not found or not authorized' });
    }

    const originalAccount = await Account.findById(transaction.account).session(session);
    const newAccount = await Account.findById(accountId).session(session);
    
    if (!originalAccount || !newAccount) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Account not found' });
    }

    if (transaction.type === 'income') {
      originalAccount.balance -= transaction.amount;
    } else {
      originalAccount.balance += transaction.amount;
    }
    await originalAccount.save({ session });

    const newAmount = Number(amount);
    if (type === 'income') {
      newAccount.balance += newAmount;
    } else {
      newAccount.balance -= newAmount;
    }
    
    if (originalAccount._id.toString() !== newAccount._id.toString()) {
      await newAccount.save({ session });
    }

    transaction.description = description || transaction.description;
    transaction.amount = newAmount || transaction.amount;
    transaction.type = type || transaction.type;
    transaction.category = category || transaction.category;
    transaction.date = date ? moment.tz(date, "Asia/Kolkata").toDate() : transaction.date;
    transaction.account = accountId || transaction.account;
    
    const updatedTransaction = await transaction.save({ session });

    await session.commitTransaction();
    res.json(updatedTransaction);

  } catch (error) {
    await session.abortTransaction();
    console.error("Update Transaction Error:", error);
    res.status(500).json({ message: 'Server Error' });
  } finally {
    session.endSession();
  }
};

// @desc    Delete a transaction
// @route   DELETE /api/transactions/:id
// @access  Private
const deleteTransaction = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const transaction = await Transaction.findById(req.params.id).session(session);
    if (!transaction || transaction.user.toString() !== req.user._id.toString()) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Transaction not found or not authorized' });
    }

    const account = await Account.findById(transaction.account).session(session);
    if (account) {
      if (transaction.type === 'income') {
        account.balance -= transaction.amount;
      } else {
        account.balance += transaction.amount;
      }
      await account.save({ session });
    }
    
    await transaction.deleteOne({ session });
    
    await session.commitTransaction();
    res.json({ message: 'Transaction removed' });

  } catch (error) {
    await session.abortTransaction();
    console.error("Delete Transaction Error:", error);
    res.status(500).json({ message: 'Server Error' });
  } finally {
    session.endSession();
  }
};

export {
  addTransaction,
  getTransactions,
  updateTransaction,
  deleteTransaction
};
