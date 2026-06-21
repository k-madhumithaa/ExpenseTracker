import axios from 'axios';
import FormData from 'form-data';
import moment from 'moment-timezone'; // For accurate date parsing and timezone locking

// --- Helper: Find Total Amount ---
const findTotalAmount = (parsedText) => {
    if (!parsedText) return null;

    const lines = parsedText.split('\n');
    let potentialTotals = [];
    const totalKeywords = ['Total', 'Amount', 'NET', 'Balance', 'Paid'];
    const amountRegex = /[₹$€£]?\s?([\d,]+(?:\.\d{2})?)\b/g;

    for (let i = lines.length - 1; i >= 0; i--) {
        const lineText = lines[i].trim();
        let amountsOnLine = [];
        let match;
        amountRegex.lastIndex = 0; 

        while ((match = amountRegex.exec(lineText)) !== null) {
            const numStr = match[1].replace(/,/g, '');
            const num = parseFloat(numStr);
            if (!isNaN(num)) {
                amountsOnLine.push(num);
            }
        }

        if (amountsOnLine.length > 0) {
            const largestAmountOnLine = Math.max(...amountsOnLine);
            let priority = 3; 

            if (totalKeywords.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(lineText))) {
                priority = 1; 
                console.log(`OCR Parse: Found amount ${largestAmountOnLine} with keyword on line ${i}`);
            }
            else if (i > 0 && totalKeywords.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(lines[i-1]))) {
                 priority = 2; 
                 console.log(`OCR Parse: Found amount ${largestAmountOnLine} on line ${i}, keyword on line ${i-1}`);
            } else {
                 console.log(`OCR Parse: Found amount ${largestAmountOnLine} on line ${i} (no keyword nearby)`);
            }
            potentialTotals.push({ amount: largestAmountOnLine, lineIndex: i, priority: priority });
        }
    }

    if (potentialTotals.length === 0) return null;

    potentialTotals.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return b.amount - a.amount;
    });

    console.log("OCR Parse: Selected Total:", potentialTotals[0].amount);
    return potentialTotals[0].amount.toFixed(2); 
};

// --- Helper: Find Date with strict Asia/Kolkata timezone mapping ---
const findDate = (parsedText) => {
    if (!parsedText) return null;
    console.log("OCR Parse: Searching for Date/Time...");

    const dateTimeRegex = /(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*-\d{2,4})[,\s]*(\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)?)?/gi;

    let possibleDateTimes = [];
    let dateMatch;

    while ((dateMatch = dateTimeRegex.exec(parsedText)) !== null) {
        let dateString = dateMatch[1];
        let timeString = dateMatch[2] || ''; 

        const formatsToTry = timeString ? [
            'DD/MM/YY hh:mm:ss A', 'DD-MM-YY hh:mm:ss A',
            'DD/MM/YYYY hh:mm:ss A', 'DD-MM-YYYY hh:mm:ss A',
            'MM/DD/YY hh:mm:ss A', 'MM-DD-YY hh:mm:ss A',
            'MM/DD/YYYY hh:mm:ss A', 'MM-DD-YYYY hh:mm:ss A',
            'YYYY-MM-DD hh:mm:ss A', 'DD-MMM-YYYY hh:mm:ss A',
            'DD/MM/YY HH:mm:ss', 'DD-MM-YY HH:mm:ss',
            'DD/MM/YYYY HH:mm:ss', 'DD-MM-YYYY HH:mm:ss',
            'MM/DD/YY HH:mm:ss', 'MM-DD-YY HH:mm:ss',
            'MM/DD/YYYY HH:mm:ss', 'MM-DD-YYYY HH:mm:ss',
            'YYYY-MM-DD HH:mm:ss', 'DD-MMM-YYYY HH:mm:ss',
            'DD/MM/YY HH:mm', 'DD-MM-YY HH:mm',
            'DD/MM/YYYY HH:mm', 'DD-MM-YYYY HH:mm',
            'MM/DD/YY HH:mm', 'MM-DD-YY HH:mm',
            'MM/DD/YYYY HH:mm', 'MM-DD-YYYY HH:mm',
            'YYYY-MM-DD HH:mm', 'DD-MMM-YYYY HH:mm'
        ] : [
            'DD/MM/YY', 'DD-MM-YY',
            'DD/MM/YYYY', 'DD-MM-YYYY',
            'MM/DD/YY', 'MM-DD-YY',
            'MM/DD/YYYY', 'MM-DD-YYYY',
            'YYYY-MM-DD', 'DD-MMM-YYYY'
        ];

        const cleanDateTimeStr = (dateString + ' ' + timeString.trim()).trim();
        
        // --- FIX: Strict parsing locked directly to Indian Standard Time context ---
        let parsed = moment.tz(cleanDateTimeStr, formatsToTry, true, "Asia/Kolkata");

        if (parsed.isValid()) {
            if (dateString.match(/\d{2}$/) && parsed.year() > moment().year() + 1) {
                parsed.subtract(100, 'years'); 
            }
            console.log(`OCR Parse: Valid DateTime found: ${parsed.format()} from string: "${dateMatch[0]}"`);
            possibleDateTimes.push(parsed);
        }
    }

    if (possibleDateTimes.length > 0) {
        possibleDateTimes.sort((a, b) => b.valueOf() - a.valueOf()); 
        const selectedDateISO = possibleDateTimes[0].format(); // Returns standardized layout string with local offsets preserved
        console.log("OCR Parse: Selected DateTime (ISO String):", selectedDateISO);
        return selectedDateISO; 
    }

    console.log("OCR Parse: No valid date/time found.");
    return null; 
};

// --- Helper: Find Vendor with Multi-Line Location fallback matching ---
const findVendor = (parsedText) => {
     if (!parsedText) return null;
     console.log("OCR Parse: Searching for Vendor...");
     const lines = parsedText.split('\n')
                           .map(line => line.trim().replace(/\s{2,}/g, ' '))
                           .filter(line => line.length > 0);

     if (lines.length === 0) return null;

     let potentialVendors = [];
     const maxLinesToCheck = Math.min(lines.length, 5); 
     const stopKeywords = ['bill', 'invoice', 'receipt', 'date', 'time', 'gstin', 'phone', 'ph:', 'address', 'customer', 'cashier', 'order', 'table', 'item', 'qty', 'rate', 'amount', 'total', 'tax'];

     for (let i = 0; i < maxLinesToCheck; i++) {
        const line = lines[i];

        if (stopKeywords.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(line))) {
            console.log(`OCR Parse: Stopping vendor search at line ${i} due to keyword filter.`);
            break;
        }

        if (line.length < 3 || line.length > 60) continue; 
        if (!line.match(/[a-zA-Z]/)) continue; 
        if (line.match(/^\d+[-/\s]+\d+[-/\s]+\d+/)) continue; 
        if (line.match(/^\d{1,2}:\d{2}/)) continue; 
        if (line.match(/\d{6,}/) && !line.match(/[a-zA-Z]{3,}/)) continue; 

        potentialVendors.push(line);
     }

     if (potentialVendors.length > 0) {
         // --- FIX: Multi-line structural extraction matching ---
         let vendorName = potentialVendors[0];
         const standaloneLocations = ['BANGALORE', 'BENGALURU', 'MUMBAI', 'DELHI', 'CHENNAI'];
         
         if (standaloneLocations.includes(vendorName.toUpperCase()) && potentialVendors.length > 1) {
             vendorName = `${vendorName} - ${potentialVendors[1]}`;
         } else if (potentialVendors.length > 1 && potentialVendors[1].length < 40 && !potentialVendors[1].match(/^\d/)) {
             if (!potentialVendors[1].match(/^(?:no|#|plot|apt|near|phone|tel)/i)) {
                  vendorName += ` ${potentialVendors[1]}`;
             }
         }

         vendorName = vendorName.substring(0, 100); 
         console.log("OCR Parse: Selected Vendor:", vendorName);
         return vendorName;
     }

     return lines[0].substring(0, 100);
};

// --- Main Route Handler ---
// @desc    Scan a receipt image using OCR.space
// @route   POST /api/ocr/scan-receipt
// @access  Private
const scanReceipt = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No receipt image uploaded.' });
    }
    if (!process.env.OCR_SPACE_API_KEY) {
         console.error("OCR.space API Key not configured.");
         return res.status(500).json({ message: 'OCR service not configured.' });
    }

    console.log(`Received file: ${req.file.originalname}, Size: ${req.file.size}`);

    try {
        const form = new FormData();
        form.append('apikey', process.env.OCR_SPACE_API_KEY);
        form.append('language', 'eng'); 
        form.append('isOverlayRequired', 'false');
        form.append('detectOrientation', 'true');
        form.append('scale', 'true');
        form.append('isTable', 'true'); 
        form.append('OCREngine', '2'); 

        form.append('file', req.file.buffer, { filename: req.file.originalname });

        console.log("Sending request to OCR.space...");
        const response = await axios.post('https://api.ocr.space/parse/image', form, {
            headers: form.getHeaders(),
        });

        console.log("OCR.space Response Status:", response.status);

        if (response.data?.OCRExitCode === 1 && response.data.ParsedResults?.length > 0) {
            const parsedText = response.data.ParsedResults[0].ParsedText;
            console.log("--- OCR Parsed Text ---");
            console.log(parsedText);
            console.log("-----------------------");

            const totalAmount = findTotalAmount(parsedText);
            const transactionDate = findDate(parsedText);
            const vendor = findVendor(parsedText);

            res.json({
                success: true,
                amount: totalAmount,
                date: transactionDate, 
                description: vendor || 'Scanned Bill', 
            });
        } else {
            console.error("OCR.space Error:", response.data?.ErrorMessage?.join(', '));
            throw new Error(response.data?.ErrorMessage?.join(', ') || 'OCR parsing failed.');
        }
    } catch (error) {
        console.error('!!! Error calling OCR.space API !!!', error.message);
        res.status(500).json({ message: 'Failed to process receipt image.' });
    }
};

export { scanReceipt };
