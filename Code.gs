const CONFIG = {
  PREFIX: "Expense Tracker - ",
  FOLDER_NAME: "Expense Tracker",
  EXPENSE_SHEET: "Expenses",
  DASHBOARD_SHEET: "Dashboard",
  DASHBOARD_TITLE: "Expense Dashboard",
  DASHBOARD_TOTAL_HEADER: "Total",
  TOTAL_LABEL: "TOTAL",
  DATE_FORMAT: "dd/MM/yyyy HH:mm",
  CURRENCY_FORMAT: '"₹"#,##0.00',
  CATEGORY_DROPDOWN_START_ROW: 2,
  POSITIVE_AMOUNT_COLOR: "#e6f4ea",
  HEADERS: [
    "Date",
    "Category",
    "Amount",
    "Notes"
  ],
  CATEGORIES: [
    "Food",
    "Travel",
    "Shopping",
    "Entertainment",
    "Personal",
    "Other"
  ]
};

/**
 * Web App entry point for Apple Shortcut POST requests.
 *
 * Expected JSON:
 * {
 *   "category": "Food",
 *   "amount": 250,
 *   "note": "Lunch"
 * }
 */
function doPost(event) {
  try {
    return handleRequest(event);
  } catch (error) {
    if (error.name === "ClientError") {
      return sendError(error.message);
    }

    return sendError("Unexpected server error.", {
      message: error.message
    });
  }
}

/**
 * Parses, validates, stores the expense, and returns a JSON response.
 */
function handleRequest(event) {
  const currentDate = new Date();
  const payload = parseJsonPayload(event);
  const category = validateCategory(payload.category);
  const amount = validateAmount(payload.amount);
  const note = validateNote(payload.note);
  const lock = LockService.getScriptLock();

  lock.waitLock(30000);

  try {
    const monthName = getCurrentMonthName(currentDate);
    const spreadsheetName = buildSpreadsheetName(monthName);
    const spreadsheet = getMonthlySpreadsheet(monthName, spreadsheetName);

    appendExpense(spreadsheet, {
      date: currentDate,
      category: category,
      amount: amount,
      note: note
    });

    return sendSuccess({
      message: "Expense recorded successfully.",
      spreadsheetName: spreadsheet.getName(),
      month: monthName,
      category: category,
      amount: amount,
      note: note
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Returns the current month name in the spreadsheet naming format.
 */
function getCurrentMonthName(currentDate) {
  return Utilities.formatDate(
    currentDate,
    Session.getScriptTimeZone(),
    "MMMM yyyy"
  );
}

/**
 * Builds the monthly spreadsheet name from CONFIG.
 */
function buildSpreadsheetName(monthName) {
  return CONFIG.PREFIX + monthName;
}

/**
 * Opens the monthly spreadsheet by locating it inside the configured folder.
 */
function getMonthlySpreadsheet(monthName, spreadsheetName) {
  const folder = getTrackerFolder();
  const cachedSpreadsheet = getCachedSpreadsheet(
    monthName,
    spreadsheetName,
    folder
  );

  // Performance: opening a valid cached ID avoids a Drive-wide file search.
  if (cachedSpreadsheet) {
    repairSpreadsheetStructure(cachedSpreadsheet, monthName);
    return cachedSpreadsheet;
  }

  const foundSpreadsheet = findSpreadsheet(spreadsheetName, folder);

  if (foundSpreadsheet) {
    cacheSpreadsheetId(monthName, foundSpreadsheet.getId());
    repairSpreadsheetStructure(foundSpreadsheet, monthName);
    return foundSpreadsheet;
  }

  const createdSpreadsheet = createSpreadsheet(spreadsheetName, folder, monthName);
  cacheSpreadsheetId(monthName, createdSpreadsheet.getId());
  return createdSpreadsheet;
}

/**
 * Opens and validates the cached monthly spreadsheet without searching Drive.
 */
function getCachedSpreadsheet(monthName, spreadsheetName, folder) {
  const spreadsheetId = PropertiesService
    .getScriptProperties()
    .getProperty(buildCacheKey(monthName));

  if (!spreadsheetId) {
    return null;
  }

  try {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const file = DriveApp.getFileById(spreadsheetId);

    if (
      spreadsheet.getName() !== spreadsheetName ||
      isDriveItemTrashed(file) ||
      !isFileInFolder(file, folder)
    ) {
      clearCachedSpreadsheetId(monthName);
      return null;
    }

    return spreadsheet;
  } catch (error) {
    clearCachedSpreadsheetId(monthName);
    return null;
  }
}

/**
 * Opens the configured Drive folder using cached IDs first, then Drive search.
 */
function getTrackerFolder() {
  const cachedFolder = getCachedFolder();

  if (cachedFolder && cachedFolder.getName() === CONFIG.FOLDER_NAME && !isDriveItemTrashed(cachedFolder)) {
    return cachedFolder;
  }

  const foundFolder = findFolder();

  if (foundFolder) {
    cacheFolderId(foundFolder.getId());
    return foundFolder;
  }

  const createdFolder = DriveApp.createFolder(CONFIG.FOLDER_NAME);
  cacheFolderId(createdFolder.getId());
  return createdFolder;
}

/**
 * Attempts to open the configured Drive folder ID stored in Script Properties.
 */
function getCachedFolder() {
  const folderId = PropertiesService
    .getScriptProperties()
    .getProperty(buildFolderCacheKey());

  if (!folderId) {
    return null;
  }

  try {
    return DriveApp.getFolderById(folderId);
  } catch (error) {
    clearCachedFolderId();
    return null;
  }
}

/**
 * Searches Drive once for the exact configured folder name.
 */
function findFolder() {
  const escapedName = CONFIG.FOLDER_NAME.replace(/'/g, "\\'");
  const query = [
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    "title = '" + escapedName + "'"
  ].join(" and ");
  const folders = DriveApp.searchFolders(query);

  if (!folders.hasNext()) {
    return null;
  }

  return folders.next();
}

/**
 * Safely checks whether a Drive item is trashed when the method is available.
 */
function isDriveItemTrashed(item) {
  return typeof item.isTrashed === "function" && item.isTrashed();
}

/**
 * Searches the configured Drive folder once for the exact monthly spreadsheet name.
 */
function findSpreadsheet(spreadsheetName, folder) {
  const escapedName = spreadsheetName.replace(/'/g, "\\'");
  const query = [
    "mimeType = 'application/vnd.google-apps.spreadsheet'",
    "trashed = false",
    "'" + folder.getId() + "' in parents",
    "title = '" + escapedName + "'"
  ].join(" and ");
  const files = DriveApp.searchFiles(query);

  if (!files.hasNext()) {
    return null;
  }

  return SpreadsheetApp.openById(files.next().getId());
}

/**
 * Creates and fully initializes a new monthly spreadsheet.
 */
function createSpreadsheet(spreadsheetName, folder, monthName) {
  const spreadsheet = SpreadsheetApp.create(spreadsheetName);
  ensureSpreadsheetInFolder(spreadsheet, folder);
  initializeSpreadsheet(spreadsheet, monthName);
  return spreadsheet;
}

/**
 * Moves a spreadsheet file into the configured Drive folder.
 */
function ensureSpreadsheetInFolder(spreadsheet, folder) {
  const file = DriveApp.getFileById(spreadsheet.getId());

  if (!isFileInFolder(file, folder)) {
    file.moveTo(folder);
  }

  removeSpreadsheetFromRoot(file);
}

/**
 * Checks folder membership without performing a Drive search.
 */
function isFileInFolder(file, folder) {
  const parents = file.getParents();

  while (parents.hasNext()) {
    if (parents.next().getId() === folder.getId()) {
      return true;
    }
  }

  return false;
}

/**
 * Ensures a spreadsheet file is not left in the Drive root after moving.
 */
function removeSpreadsheetFromRoot(file) {
  const rootFolder = DriveApp.getRootFolder();

  try {
    rootFolder.removeFile(file);
  } catch (error) {
    // The file is already out of My Drive root, or the runtime uses single-parent Drive behavior.
  }
}

/**
 * Ensures every monthly spreadsheet has exactly the configured sheets.
 */
function initializeSpreadsheet(spreadsheet, monthName) {
  ensureConfiguredSheets(spreadsheet);
  initializeExpensesSheet(spreadsheet.getSheetByName(CONFIG.EXPENSE_SHEET));
  createDashboard(spreadsheet, monthName);
  removeUnexpectedSheets(spreadsheet);
}

/**
 * Performs only small integrity checks on an existing spreadsheet.
 * Expensive formatting is reserved for sheets that must be recreated.
 */
function repairSpreadsheetStructure(spreadsheet, monthName) {
  let expenseSheet = spreadsheet.getSheetByName(CONFIG.EXPENSE_SHEET);
  let dashboardSheet = spreadsheet.getSheetByName(CONFIG.DASHBOARD_SHEET);

  if (!expenseSheet) {
    expenseSheet = spreadsheet.insertSheet(CONFIG.EXPENSE_SHEET);
    initializeExpensesSheet(expenseSheet);
  } else {
    // Performance: read only the header cells and write only when missing.
    ensureExpensesHeaders(expenseSheet);

    if (!hasCategoryDropdown(expenseSheet)) {
      applyCategoryDropdown(expenseSheet);
    }

    if (!hasConditionalFormatting(expenseSheet)) {
      applyConditionalFormatting(expenseSheet);
    }

    if (expenseSheet.getBandings().length === 0) {
      applyAlternatingRowColors(expenseSheet);
    }
  }

  if (!dashboardSheet) {
    spreadsheet.insertSheet(CONFIG.DASHBOARD_SHEET);
    createDashboard(spreadsheet, monthName);
  } else if (!hasDashboardFormulas(dashboardSheet)) {
    // Performance: rebuild the Dashboard only when its formulas are incomplete.
    createDashboard(spreadsheet, monthName);
  }

  // Preserve the exact two-sheet structure without reformatting either sheet.
  removeUnexpectedSheets(spreadsheet);
}

/**
 * Creates missing configured sheets and reuses existing ones.
 */
function ensureConfiguredSheets(spreadsheet) {
  let expenseSheet = spreadsheet.getSheetByName(CONFIG.EXPENSE_SHEET);

  if (!expenseSheet) {
    const sheets = spreadsheet.getSheets();
    const defaultSheet = sheets.length === 1 ? sheets[0] : null;
    expenseSheet = defaultSheet
      ? defaultSheet.setName(CONFIG.EXPENSE_SHEET)
      : spreadsheet.insertSheet(CONFIG.EXPENSE_SHEET);
  }

  if (!spreadsheet.getSheetByName(CONFIG.DASHBOARD_SHEET)) {
    spreadsheet.insertSheet(CONFIG.DASHBOARD_SHEET);
  }
}

/**
 * Removes non-configured sheets only after the required two sheets exist.
 */
function removeUnexpectedSheets(spreadsheet) {
  const allowedSheetNames = [
    CONFIG.EXPENSE_SHEET,
    CONFIG.DASHBOARD_SHEET
  ];

  spreadsheet.getSheets().forEach(function(sheet) {
    if (allowedSheetNames.indexOf(sheet.getName()) === -1) {
      spreadsheet.deleteSheet(sheet);
    }
  });
}

/**
 * Adds headers and production formatting to the Expenses sheet.
 */
function initializeExpensesSheet(sheet) {
  ensureExpensesHeaders(sheet);

  const headerRange = sheet.getRange(1, 1, 1, CONFIG.HEADERS.length);

  headerRange
    .setFontWeight("bold")
    .setBackground("#e8f0fe");

  sheet.setFrozenRows(1);
  sheet.getRange("A:A").setNumberFormat(CONFIG.DATE_FORMAT);
  sheet.getRange("C:C").setNumberFormat(CONFIG.CURRENCY_FORMAT);
  applyCategoryDropdown(sheet);
  applyConditionalFormatting(sheet);
  applyAlternatingRowColors(sheet);
  sheet.autoResizeColumns(1, CONFIG.HEADERS.length);
}

/**
 * Repairs missing headers without overwriting existing expense data.
 */
function ensureExpensesHeaders(sheet) {
  const headerRange = sheet.getRange(1, 1, 1, CONFIG.HEADERS.length);
  const existingHeaders = headerRange.getValues()[0];

  if (arraysMatch(existingHeaders, CONFIG.HEADERS)) {
    return;
  }

  // Preserve existing three-column data when repairing the Notes header.
  if (
    arraysMatch(
      existingHeaders.slice(0, CONFIG.HEADERS.length - 1),
      CONFIG.HEADERS.slice(0, CONFIG.HEADERS.length - 1)
    ) &&
    (existingHeaders[CONFIG.HEADERS.length - 1] === "" ||
      existingHeaders[CONFIG.HEADERS.length - 1] === null)
  ) {
    sheet
      .getRange(1, CONFIG.HEADERS.length)
      .setValue(CONFIG.HEADERS[CONFIG.HEADERS.length - 1]);
    return;
  }

  if (isBlankRow(existingHeaders) && sheet.getLastRow() <= 1) {
    headerRange.setValues([CONFIG.HEADERS]);
    return;
  }

  sheet.insertRowBefore(1);
  sheet.getRange(1, 1, 1, CONFIG.HEADERS.length).setValues([CONFIG.HEADERS]);
}

/**
 * Applies category validation to all editable category cells.
 */
function applyCategoryDropdown(sheet) {
  const maxRows = Math.max(sheet.getMaxRows() - 1, 1);
  const rule = SpreadsheetApp
    .newDataValidation()
    .requireValueInList(CONFIG.CATEGORIES, true)
    .setAllowInvalid(false)
    .build();

  sheet
    .getRange(CONFIG.CATEGORY_DROPDOWN_START_ROW, 2, maxRows, 1)
    .setDataValidation(rule);
}

/**
 * Checks the first editable category cell before recreating validation.
 */
function hasCategoryDropdown(sheet) {
  return Boolean(
    sheet
      .getRange(CONFIG.CATEGORY_DROPDOWN_START_ROW, 2)
      .getDataValidation()
  );
}

/**
 * Rebuilds conditional formatting for the Expenses sheet.
 */
function applyConditionalFormatting(sheet) {
  const amountRange = sheet.getRange(
    CONFIG.CATEGORY_DROPDOWN_START_ROW,
    3,
    Math.max(sheet.getMaxRows() - 1, 1),
    1
  );
  const rules = [
    SpreadsheetApp
      .newConditionalFormatRule()
      .whenNumberGreaterThan(0)
      .setBackground(CONFIG.POSITIVE_AMOUNT_COLOR)
      .setRanges([amountRange])
      .build()
  ];

  sheet.setConditionalFormatRules(rules);
}

/**
 * Checks whether an amount-column conditional formatting rule still exists.
 */
function hasConditionalFormatting(sheet) {
  return sheet.getConditionalFormatRules().some(function(rule) {
    return rule.getRanges().some(function(range) {
      return range.getColumn() === 3;
    });
  });
}

/**
 * Rebuilds the Dashboard sheet without duplicating rows or formulas.
 */
function createDashboard(spreadsheet, monthName) {
  const dashboardSheet = spreadsheet.getSheetByName(CONFIG.DASHBOARD_SHEET);
  const dashboardValueRowCount = CONFIG.CATEGORIES.length + 1;
  const titleRow = 1;
  const monthRow = titleRow + 1;
  const headerRow = monthRow + 2;
  const categoryStartRow = headerRow + 1;
  const categoryEndRow = categoryStartRow + CONFIG.CATEGORIES.length - 1;
  const totalRow = categoryEndRow + 1;

  dashboardSheet
    .getRange(1, 1, dashboardSheet.getMaxRows(), dashboardSheet.getMaxColumns())
    .breakApart();
  dashboardSheet.clear();
  dashboardSheet.getRange(titleRow, 1).setValue(CONFIG.DASHBOARD_TITLE);
  dashboardSheet.getRange(titleRow, 1, 1, 2)
    .merge()
    .setFontWeight("bold")
    .setFontSize(16)
    .setHorizontalAlignment("center")
    .setBackground("#174ea6")
    .setFontColor("#ffffff");

  dashboardSheet.getRange(monthRow, 1).setValue(monthName);
  dashboardSheet.getRange(monthRow, 1, 1, 2)
    .merge()
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setBackground("#cfe2f3");

  dashboardSheet.getRange(headerRow, 1, 1, 2)
    .setValues([[CONFIG.HEADERS[1], CONFIG.DASHBOARD_TOTAL_HEADER]])
    .setFontWeight("bold")
    .setBackground("#d9ead3");

  const categoryRows = CONFIG.CATEGORIES.map(function(category) {
    return [
      category,
      '=SUMIF(' + CONFIG.EXPENSE_SHEET + '!B:B,"' + category + '",' + CONFIG.EXPENSE_SHEET + '!C:C)'
    ];
  });

  dashboardSheet
    .getRange(categoryStartRow, 1, categoryRows.length, 2)
    .setValues(categoryRows);

  const totalFormula = "=SUM(B" + categoryStartRow + ":B" + categoryEndRow + ")";

  dashboardSheet
    .getRange(totalRow, 1, 1, 2)
    .setValues([[CONFIG.TOTAL_LABEL, totalFormula]])
    .setFontWeight("bold")
    .setBackground("#fff2cc");

  dashboardSheet
    .getRange(categoryStartRow, 2, dashboardValueRowCount, 1)
    .setNumberFormat(CONFIG.CURRENCY_FORMAT);
  dashboardSheet.autoResizeColumns(1, 2);
}

/**
 * Checks the generated Dashboard formula cells without rebuilding the sheet.
 */
function hasDashboardFormulas(dashboardSheet) {
  const headerRow = 4;
  const categoryStartRow = headerRow + 1;
  const formulas = dashboardSheet
    .getRange(categoryStartRow, 2, CONFIG.CATEGORIES.length + 1, 1)
    .getFormulas()
    .map(function(row) {
      return row[0];
    });

  for (let index = 0; index < CONFIG.CATEGORIES.length; index++) {
    const category = CONFIG.CATEGORIES[index];
    const expectedFormula =
      '=SUMIF(' + CONFIG.EXPENSE_SHEET + '!B:B,"' + category + '",' +
      CONFIG.EXPENSE_SHEET + '!C:C)';

    if (formulas[index] !== expectedFormula) {
      return false;
    }
  }

  const categoryEndRow = categoryStartRow + CONFIG.CATEGORIES.length - 1;
  const expectedTotalFormula =
    "=SUM(B" + categoryStartRow + ":B" + categoryEndRow + ")";

  return formulas[CONFIG.CATEGORIES.length] === expectedTotalFormula;
}

/**
 * Appends a validated expense and keeps the sheet sorted by Date.
 */
function appendExpense(spreadsheet, expense) {
  const sheet = spreadsheet.getSheetByName(CONFIG.EXPENSE_SHEET);
  const lastRow = sheet.getLastRow() + 1;
  const appendedRange = sheet.getRange(lastRow, 1, 1, CONFIG.HEADERS.length);

  // Performance: one batched write replaces appendRow plus full-column formatting.
  appendedRange.setValues([[
    expense.date,
    expense.category,
    expense.amount,
    expense.note
  ]]);
  sheet.getRange(lastRow, 1).setNumberFormat(CONFIG.DATE_FORMAT);
  sheet.getRange(lastRow, 3).setNumberFormat(CONFIG.CURRENCY_FORMAT);

  if (lastRow > 2) {
    // Sorting is retained because it is an existing user-visible feature.
    sheet
      .getRange(2, 1, lastRow - 1, CONFIG.HEADERS.length)
      .sort({ column: 1, ascending: true });
  }
}

/**
 * Parses JSON from the Apps Script Web App event.
 */
function parseJsonPayload(event) {
  if (!event || !event.postData || !event.postData.contents) {
    throwClientError("Request body is missing.");
  }

  try {
    return JSON.parse(event.postData.contents);
  } catch (error) {
    throwClientError("Request body must be valid JSON.");
  }
}

/**
 * Validates the required category value.
 */
function validateCategory(category) {
  if (category === undefined || category === null || String(category).trim() === "") {
    throwClientError("Category is missing.");
  }

  const normalizedCategory = String(category).trim();

  if (CONFIG.CATEGORIES.indexOf(normalizedCategory) === -1) {
    throwClientError("Category is not supported.");
  }

  return normalizedCategory;
}

/**
 * Validates the required amount value.
 */
function validateAmount(amount) {
  if (amount === undefined || amount === null || String(amount).trim() === "") {
    throwClientError("Amount is missing.");
  }

  const numericAmount = Number(amount);

  if (!isFinite(numericAmount)) {
    throwClientError("Amount must be numeric.");
  }

  return numericAmount;
}

/**
 * Normalizes the Notes value while preserving an empty optional note.
 */
function validateNote(note) {
  if (note === undefined || note === null) {
    return "";
  }

  return String(note).trim();
}

/**
 * Returns a JSON success response.
 */
function sendSuccess(data) {
  return ContentService
    .createTextOutput(JSON.stringify({
      success: true,
      data: data
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Returns a JSON error response.
 */
function sendError(message, details) {
  const response = {
    success: false,
    error: message
  };

  if (details) {
    response.details = details;
  }

  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Throws a client-facing validation error.
 */
function throwClientError(message) {
  throw new ClientError(message);
}

/**
 * Identifies validation errors separately from unexpected exceptions.
 */
function ClientError(message) {
  this.name = "ClientError";
  this.message = message;
}

/**
 * Builds a stable script property key for a month.
 */
function buildCacheKey(monthName) {
  return "spreadsheetId:" + monthName;
}

/**
 * Builds a stable script property key for the Drive folder.
 */
function buildFolderCacheKey() {
  return "folderId:" + CONFIG.FOLDER_NAME;
}

/**
 * Saves a monthly spreadsheet ID in Script Properties.
 */
function cacheSpreadsheetId(monthName, spreadsheetId) {
  PropertiesService
    .getScriptProperties()
    .setProperty(buildCacheKey(monthName), spreadsheetId);
}

/**
 * Removes a stale spreadsheet ID from Script Properties.
 */
function clearCachedSpreadsheetId(monthName) {
  PropertiesService
    .getScriptProperties()
    .deleteProperty(buildCacheKey(monthName));
}

/**
 * Saves the Drive folder ID in Script Properties.
 */
function cacheFolderId(folderId) {
  PropertiesService
    .getScriptProperties()
    .setProperty(buildFolderCacheKey(), folderId);
}

/**
 * Removes a stale Drive folder ID from Script Properties.
 */
function clearCachedFolderId() {
  PropertiesService
    .getScriptProperties()
    .deleteProperty(buildFolderCacheKey());
}

/**
 * Applies alternating row colors to Expenses without stacking bandings.
 */
function applyAlternatingRowColors(sheet) {
  sheet.getBandings().forEach(function(banding) {
    banding.remove();
  });

  const maxRows = Math.max(sheet.getMaxRows(), 2);
  const range = sheet.getRange(1, 1, maxRows, CONFIG.HEADERS.length);

  range
    .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY)
    .setHeaderRowColor("#e8f0fe")
    .setFirstRowColor("#ffffff")
    .setSecondRowColor("#f8f9fa");
}

/**
 * Compares two one-dimensional arrays by value.
 */
function arraysMatch(firstArray, secondArray) {
  if (firstArray.length !== secondArray.length) {
    return false;
  }

  for (let index = 0; index < firstArray.length; index++) {
    if (firstArray[index] !== secondArray[index]) {
      return false;
    }
  }

  return true;
}

/**
 * Checks whether a row contains no meaningful values.
 */
function isBlankRow(rowValues) {
  return rowValues.every(function(value) {
    return value === "" || value === null;
  });
}
