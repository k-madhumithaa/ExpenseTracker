import RecurringTransaction from '../models/RecurringTransaction.js';
import Transaction from '../models/Transaction.js';
import Account from '../models/Account.js';
import mongoose from 'mongoose';
import moment from 'moment';

// --- In-memory lock to prevent concurrent processing per user ---
const processingUsers = new Set();
// -------------------------------------------------------------------

// @desc    Add a recurring transaction schedule
// @route   POST /api/recurring
// @access  Private
const addRecurringTransaction = async (req, res) => {
  const { description, amount, type, category, frequency, startDate, account } = req.body;
  try {
    // Basic validation
    if (!description || !amount || !type || !category || !frequency || !startDate || !account) {
        return res.status(400).json({ message: 'Missing required fields' });
    }
    if (isNaN(Number(amount)) || Number(amount) <= 0) {
        return res.status(400).json({ message: 'Invalid amount' });
    }
    // Check if account exists and belongs to user
    const accountExists = await Account.findOne({ _id: account, user: req.user._id });
    if (!accountExists) {
        return res.status(404).json({ message: 'Account not found or not authorized' });
    }

    const recurring = new RecurringTransaction({
      user: req.user._id,
      account,
      description,
      amount: Number(amount), // Ensure amount is stored as number
      type,
      category,
      frequency,
      startDate: new Date(startDate), // Ensure start date is stored as Date
      lastProcessedDate: null, // Start with null
    });
    const createdRecurring = await recurring.save();
    res.status(201).json(createdRecurring);
  } catch (error) {
    console.error("Add Recurring Error:", error);
     if (error.name === 'ValidationError') {
        return res.status(400).json({ message: error.message });
     }
    res.status(500).json({ message: 'Server Error adding recurring schedule' });
  }
};

// @desc    Get all recurring transaction schedules
// @route   GET /api/recurring
// @access  Private
const getRecurringTransactions = async (req, res) => {
  try {
    const transactions = await RecurringTransaction.find({ user: req.user._id })
      .populate('account', 'name') // Populate account name for display
      .sort({ createdAt: -1 }); // Sort by creation date or start date
    res.json(transactions);
  } catch (error) {
     console.error("Get Recurring Error:", error);
    res.status(500).json({ message: 'Server Error fetching recurring schedules' });
  }
};

// @desc    Delete a recurring transaction schedule
// @route   DELETE /api/recurring/:id
// @access  Private
const deleteRecurringTransaction = async (req, res) => {
  try {
    const recurring = await RecurringTransaction.findOne({ _id: req.params.id, user: req.user._id }); // Combine find and user check

    if (!recurring) {
      return res.status(404).json({ message: 'Recurring transaction not found or not authorized' });
    }
    await recurring.deleteOne();
    res.json({ message: 'Recurring transaction schedule removed' });
  } catch (error) {
     console.error("Delete Recurring Error:", error);
     // Handle CastError if ID format is wrong
     if (error.name === 'CastError') {
         return res.status(400).json({ message: 'Invalid ID format' });
     }
    res.status(500).json({ message: 'Server Error deleting recurring schedule' });
  }
};


// @desc    Process any due recurring transactions (With Multi-Month Catch-Up Loop)
// @route   POST /api/recurring/process
// @access  Private
const processRecurringTransactions = async (req, res) => {
    const userId = req.user._id.toString();
    const now = moment();

    // Acquire Lock
    if (processingUsers.has(userId)) {
        console.log(`[User: ${userId}] Recurring processing skipped: Already in progress.`);
        return res.status(200).json({ message: "Processing already in progress." });
    }
    processingUsers.add(userId);
    console.log(`[User: ${userId}] Acquired lock. Starting recurring processing check...`);

    let globalProcessedCount = 0;
    let errorsOccurred = false;

    try {
        // Fetch all recurring schedules for the user
        const recurringTxs = await RecurringTransaction.find({ user: req.user._id });
        console.log(`[User: ${userId}] Found ${recurringTxs.length} recurring schedules to check.`);

        // Process each schedule individually
        for (const tx of recurringTxs) {
            let scheduleCaughtUp = false;

            // --- FIX: Use a WHILE loop to catch up on ALL missed dates ---
            while (!scheduleCaughtUp) {
                // Re-fetch current state or use updated execution baseline
                const lastRan = tx.lastProcessedDate ? moment(tx.lastProcessedDate) : moment(tx.startDate);
                const nextDueDate = lastRan.clone().add(1, tx.frequency);

                // If next due date is in the future, this specific schedule is fully caught up!
                if (nextDueDate.isAfter(now, 'day')) {
                    scheduleCaughtUp = true;
                    break; 
                }

                console.log(`[User: ${userId}] Schedule '${tx.description}' needs processing for ${nextDueDate.format('YYYY-MM-DD')}.`);

                let transactionCommitted = false;
                let retries = 3;

                while (retries > 0 && !transactionCommitted) {
                    const session = await mongoose.startSession();
                    session.startTransaction();
                    try {
                        const account = await Account.findById(tx.account).session(session);
                        const currentTxDocInDB = await RecurringTransaction.findById(tx._id).session(session);

                        if (!currentTxDocInDB) {
                           console.warn(` -> Schedule ${tx._id} deleted during processing. Aborting.`);
                           await session.abortTransaction(); 
                           scheduleCaughtUp = true; // Stop while loop
                           break; 
                        }
                        if (!account) {
                           console.warn(` -> Account ${tx.account} not found. Aborting.`);
                           await session.abortTransaction(); 
                           scheduleCaughtUp = true; // Stop while loop
                           break; 
                        }
                        if (currentTxDocInDB.lastProcessedDate && moment(currentTxDocInDB.lastProcessedDate).isSameOrAfter(nextDueDate, 'day')) {
                            console.log(` -> Date ${nextDueDate.format('YYYY-MM-DD')} already processed in DB.`);
                            await session.abortTransaction();
                            transactionCommitted = true;
                            break;
                        }

                        // Create Transaction for this specific missed date
                        const newTransaction = new Transaction({
                             user: tx.user, 
                             account: tx.account, 
                             description: tx.description,
                             amount: tx.amount, 
                             type: tx.type, 
                             category: tx.category,
                             date: nextDueDate.toDate(), 
                             recurringSource: tx._id
                         });
                        await newTransaction.save({ session });

                        // Update Balance
                        const change = tx.type === 'income' ? tx.amount : -tx.amount;
                        account.balance += change;
                        await account.save({ session });

                        // Update local object property so the parent while loop accurately calculates the NEXT loop step
                        tx.lastProcessedDate = nextDueDate.toDate(); 

                        currentTxDocInDB.lastProcessedDate = nextDueDate.toDate();
                        await currentTxDocInDB.save({ session });

                        await session.commitTransaction();
                        globalProcessedCount++;
                        transactionCommitted = true; 

                    } catch (error) {
                        await session.abortTransaction();
                        if (error.errorLabels?.includes('TransientTransactionError') || error.codeName === 'WriteConflict') {
                            retries--;
                            if (retries > 0) {
                                await new Promise(resolve => setTimeout(resolve, Math.random() * 100 + 150));
                            } else {
                                 errorsOccurred = true;
                                 scheduleCaughtUp = true; // Break loop on system failure
                            }
                        } else {
                            retries = 0;
                            errorsOccurred = true;
                            scheduleCaughtUp = true; // Break loop on hard failure
                        }
                    } finally {
                        session.endSession();
                    }
                } // End retry loop

                // Break outer while loop if transaction execution context fails out completely
                if (!transactionCommitted) {
                    break;
                }
            } // End catch-up while loop for single item
        } // End for loop for all items

        console.log(`[User: ${userId}] Finished recurring check. Total processed: ${globalProcessedCount}`);
        res.json({ message: `Processed ${globalProcessedCount} recurring transactions this run.` });

    } catch (error) {
        console.error(`!!! Global Processing Error:`, error);
        res.status(500).json({ message: 'Server error during execution.' });
    } finally {
        processingUsers.delete(userId);
    }
};

// --- Export all functions ---
export {
  addRecurringTransaction,
  getRecurringTransactions,
  deleteRecurringTransaction,
  processRecurringTransactions,
};
