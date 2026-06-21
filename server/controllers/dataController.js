import Transaction from '../models/Transaction.js';
import Account from '../models/Account.js';
import * as csv from 'fast-csv';
import csvParser from 'csv-parser';
import { Readable } from 'stream';
import mongoose from 'mongoose';
import PDFDocument from 'pdfkit';
import moment from 'moment-timezone'; // Use moment for clean, uniform timestamp sizing

// @desc    Export transactions to CSV
// @route   GET /api/data/export
// @access  Private
const exportTransactions = async (req, res) => {
  console.log('Starting CSV Export...');
  try {
    const { startDate, endDate } = req.query;
    const query = { user: req.user._id };

    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query.date = { $gte: start, $lte: end };
    }

    console.log('Fetching transactions for CSV...');
    const transactions = await Transaction.find(query)
      .populate('account', 'name')
      .sort({ date: -1 })
      .lean();
    console.log(`Fetched ${transactions.length} transactions.`);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');

    // By default, fast-csv writes headers using the keys of the object passed to it.
    const csvStream = csv.format({ headers: true });

    csvStream.on('error', (err) => {
        console.error('CSV Stream Error:', err);
        if (!res.headersSent) {
            res.status(500).send('Error generating CSV');
        } else {
            res.end();
        }
    });

    csvStream.pipe(res);

    console.log('Writing CSV rows...');

    transactions.forEach(tx => {
      const accountName = tx.account?.name || 'Account Deleted';
      
      // Escape commas in description fields to prevent cell breakdown shifts
      const cleanDescription = tx.description ? tx.description.replace(/,/g, ' ') : '';

      csvStream.write({
        // --- FIX: Use a compact, universally recognized timestamp layout that prevents ### scaling ---
        'DateTime': tx.date ? moment(tx.date).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm') : 'N/A',
        'Account': accountName,
        'Description': cleanDescription,
        'Category': tx.category || 'Uncategorized',
        'Type': tx.type || 'expense',
        'Amount (INR)': tx.amount !== undefined ? tx.amount.toFixed(2) : '0.00',
      });
    });

    console.log('Finalizing CSV...');
    csvStream.end();
    console.log('CSV Export Finished Successfully.');

  } catch (error) {
    console.error('!!! CSV Export Controller Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Server Error during CSV export' });
    } else {
        res.end();
    }
  }
};

// @desc    Import transactions from CSV
// @route   POST /api/data/import
// @access  Private
const importTransactions = async (req, res) => {
  console.log('Starting CSV Import...');
  const { accountId } = req.body;
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded.' });
  }
  if (!accountId) {
    return res.status(400).json({ message: 'No account selected.' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  console.log('Import Transaction Session Started.');

  try {
    const account = await Account.findById(accountId).session(session);
    if (!account || account.user.toString() !== req.user._id.toString()) {
      await session.abortTransaction();
      console.log('Import Aborted: Account not found or unauthorized.');
      return res.status(404).json({ message: 'Account not found or not authorized.' });
    }

    const transactionsToCreate = [];
    let totalBalanceChange = 0;
    let rowCount = 0;

    const stream = Readable.from(req.file.buffer.toString());
    console.log('Reading CSV file stream...');

    stream
      .pipe(csvParser({
          mapHeaders: ({ header }) => header.trim()
      }))
      .on('data', (row) => {
        rowCount++;
        
        // Match the variations including space formatting hooks
        const dateValue = (row['DateTime'] || row['Date'] || row['dateTime'])?.trim();
        const descValue = row['Description']?.trim();
        const amountValue = row['Amount']?.trim() || row['Amount (INR)']?.trim();
        const typeValue = row['Type']?.trim().toLowerCase();
        const catValue = row['Category']?.trim();

        const amount = parseFloat(amountValue);

        let parsedDate = null;
        if (dateValue) {
            // Support both YYYY-MM-DD and locale values smoothly
            const ddMMyyyyParts = dateValue.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
            if (ddMMyyyyParts) {
                const year = ddMMyyyyParts[3];
                const month = ddMMyyyyParts[2].padStart(2, '0');
                const day = ddMMyyyyParts[1].padStart(2, '0');
                const timeMatch = dateValue.match(/(\d{1,2}:\d{2}(:\d{2})?)/);
                const timeString = timeMatch ? `T${timeMatch[1]}` : 'T00:00:00';
                parsedDate = new Date(`${year}-${month}-${day}${timeString}`);
            } else {
                parsedDate = new Date(dateValue);
            }
        }
        const isValidDate = parsedDate instanceof Date && !isNaN(parsedDate);

        if (isValidDate && descValue && !isNaN(amount) && (typeValue === 'income' || typeValue === 'expense')) {
          transactionsToCreate.push({
            user: req.user._id,
            account: accountId,
            date: parsedDate,
            description: descValue,
            amount: amount,
            type: typeValue,
            category: catValue || 'Uncategorized',
          });
          totalBalanceChange += (typeValue === 'income' ? amount : -amount);
        } else {
            console.warn(`Skipping invalid row ${rowCount}: Date='${dateValue}'`, row);
        }
      })
      .on('end', async () => {
        console.log(`CSV Parsing Finished. Found ${transactionsToCreate.length} valid transactions.`);
        try {
          if (transactionsToCreate.length > 0) {
            console.log('Inserting transactions into DB...');
            await Transaction.insertMany(transactionsToCreate, { session });

            console.log('Updating account balance...');
            account.balance += totalBalanceChange;
            await account.save({ session });

            await session.commitTransaction();
            console.log('Import Transaction Session Committed.');
            res.json({ message: `Successfully imported ${transactionsToCreate.length} transactions.` });
          } else {
            await session.abortTransaction();
            res.status(400).json({ message: 'No valid transactions found in CSV.' });
          }
        } catch (dbError) {
          await session.abortTransaction();
          console.error('!!! Import DB Error:', dbError);
          res.status(500).json({ message: 'Error saving transactions to database' });
        } finally {
          session.endSession();
        }
      })
      .on('error', (parseError) => {
        console.error('!!! CSV Parsing Error:', parseError);
        session.abortTransaction().finally(() => session.endSession());
        if (!res.headersSent) {
             res.status(400).json({ message: 'Error parsing CSV file.' });
        }
      });

  } catch (error) {
    if (session.inTransaction()) {
        await session.abortTransaction();
    }
    session.endSession();
    console.error('!!! Import Controller Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Server Error during CSV import setup' });
    }
  }
};

// Helper function to format a table row
function generateTableRow(doc, y, c1, c2, c3, c4, c5, isHeader = false) {
  const rowHeight = 15;
  const startX = 50;
  const endX = 570;
  const textY = y + (rowHeight / 2);

  if (isHeader) {
      doc.rect(startX, y, endX - startX, rowHeight)
         .fillOpacity(0.1)
         .fill('#007bff');
      doc.fillOpacity(1);
      doc.font('Helvetica-Bold').fillColor('black');
  } else {
      doc.font('Helvetica').fillColor('black');
  }

  doc.fontSize(7.5);

  doc.text(c1 || '', startX + 5, textY, { width: 70, align: 'left', lineBreak: false, baseline: 'middle' });
  doc.text(c2 || '', startX + 75, textY, { width: 150, align: 'left', ellipsis: true, lineBreak: false, baseline: 'middle' });
  doc.text(c3 || '', startX + 230, textY, { width: 60, align: 'left', ellipsis: true, lineBreak: false, baseline: 'middle' });
  doc.text(c4 || '', startX + 295, textY, { width: 120, align: 'left', ellipsis: true, lineBreak: false, baseline: 'middle' });
  doc.text(c5 || '', endX - 95, textY, { width: 90, align: 'right', lineBreak: false, baseline: 'middle' });

  doc.moveTo(startX, y + rowHeight)
     .lineTo(endX, y + rowHeight)
     .lineWidth(0.3)
     .strokeColor('#dddddd')
     .stroke();

  return y + rowHeight;
}

// @desc    Export transactions to PDF
// @route   GET /api/data/export-pdf
// @access  Private
const exportTransactionsPDF = async (req, res) => {
  console.log('Starting PDF Export...');
  try {
    console.log('Fetching transactions for PDF...');
    const transactions = await Transaction.find({ user: req.user._id })
      .populate('account', 'name')
      .sort({ date: -1 })
      .lean();
    console.log(`Fetched ${transactions.length} transactions.`);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    doc.on('error', (err) => {
        console.error('PDF Document Stream Error:', err);
         if (!res.headersSent) {
            res.status(500).send('Error generating PDF');
        } else {
            res.end();
        }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=transactions_report.pdf');
    doc.pipe(res);

    console.log('Generating PDF content...');
    doc.fontSize(18).font('Helvetica-Bold').fillColor('black').text('Transaction Report', { align: 'center' });
    doc.fontSize(10).font('Helvetica').fillColor('black').text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
    doc.moveDown(2);

    let currentY = doc.y;
    const tableTop = currentY;
    currentY = generateTableRow(doc, tableTop, "Date & Time", "Description", "Category", "Account", "Amount", true);
    const tableBottomMargin = 700;

    let totalIncome = 0;
    let totalExpense = 0;

    for (const tx of transactions) {
      if (currentY > tableBottomMargin) {
          doc.addPage();
          currentY = 50;
          currentY = generateTableRow(doc, currentY, "Date & Time", "Description", "Category", "Account", "Amount", true);
      }

      const dateTime = tx.date ? moment(tx.date).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm') : 'N/A';
      const accountName = tx.account?.name || 'Account Deleted';
      const amountVal = tx.amount !== undefined ? tx.amount : 0;
      const amount = (tx.type === 'income' ? '+' : '-') + `₹${amountVal.toFixed(2)}`;

      if(tx.type === 'income') totalIncome += amountVal;
      if(tx.type === 'expense') totalExpense += amountVal;

      currentY = generateTableRow(doc, currentY, dateTime, tx.description || '', tx.category || '', accountName, amount);
    }

    if (currentY > tableBottomMargin - 45) {
        doc.addPage();
        currentY = 50;
    }
    doc.moveDown(3);
    currentY = doc.y;
    const summaryXLabel = 400;
    const summaryXValue = 480;
    const lineSpacing = 15;

    doc.fontSize(10).font('Helvetica-Bold').fillColor('black');

    doc.text('Total Income:', summaryXLabel, currentY, { align: 'right', width: 95 });
    doc.text(`₹${totalIncome.toFixed(2)}`, summaryXValue, currentY, { align: 'right', width: 90 });
    currentY += lineSpacing;

    doc.text('Total Expense:', summaryXLabel, currentY, { align: 'right', width: 95 });
    doc.text(`₹${totalExpense.toFixed(2)}`, summaryXValue, currentY, { align: 'right', width: 90 });

    console.log('Finalizing PDF...');
    doc.end();
    console.log('PDF Export Finished Successfully.');

  } catch (error) {
    console.error('!!! PDF Export Controller Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Server Error during PDF export' });
    } else {
        res.end();
    }
  }
};

export { exportTransactions, importTransactions, exportTransactionsPDF };
