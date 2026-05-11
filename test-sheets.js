require('dotenv').config();
const { crmSheets } = require('./src/sheets/crm-sheets');
async function run() {
    console.log("Fetching LEADS!A:Z...");
    const res = await crmSheets.getAll('LEADS');
    console.log("LEADS DATA:", res);
}
run();
