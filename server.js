const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const WHATSAPPTOKEN = process.env.WHATSAPP_TOKEN;
const PHONENUMBERID = process.env.PHONE_NUMBER_ID;
const SPREADSHEETID = process.env.SPREADSHEET_ID;

const sessions = {}; 
let orderIdCounter = 1001;

function getSession(phone) {
    if (!sessions[phone]) {
        sessions[phone] = { cart: [], tempSelection: null, step: 'start', customerDetails: '', customerName: '', customerAddress: '' };
    }
    return sessions[phone];
}

const auth = new google.auth.GoogleAuth({
    credentials: process.env.GOOGLE_CREDENTIALS ? JSON.parse(process.env.GOOGLE_CREDENTIALS) : {},
    scopes: ['https://www.googleapis.com/auth/spreadsheets'], 
});

async function getSheetData() {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEETID,
            range: 'Sheet1!A2:D100', 
        });
        return response.data.values || [];
    } catch (error) {
        console.error("Google Sheet Fetch Error:", error.message);
        return [];
    }
}

async function saveOrderToSheet(order) {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const itemsString = order.items.map(i => `${i.item}(${i.size})`).join(', ');
        
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEETID,
            range: 'Orders!A:G',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[order.id, order.phone, itemsString, order.total, order.name, order.address, order.time]] }
        });
        console.log("Order saved to sheet successfully.");
    } catch (error) { 
        console.error("Order Save Error. Make sure 'Orders' tab exists:", error.message); 
    }
}

app.get('/api/orders', async (req, res) => {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEETID,
            range: 'Orders!A2:G100', 
        });
        const rows = response.data.values || [];
        const orders = rows.map(row => ({
            id: row[0] || 'N/A', 
            phone: row[1] || 'N/A', 
            items: row[2] || 'N/A', 
            total: row[3] || '0', 
            name: row[4] || 'N/A', 
            address: row[5] || 'N/A', 
            time: row[6] || 'N/A', 
            status: 'New'
        }));
        res.json(orders);
    } catch (error) { 
        console.error("Fetch Orders Error:", error.message);
        // Crash say bachnay k liyay khali array return ki ha
        res.json([]); 
    }
});

app.post('/api/addproduct', async (req, res) => {
    try {
        const { name, size, price, videoUrl } = req.body;
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEETID,
            range: 'Sheet1!A:D',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[name, size, price, videoUrl]] }
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    try {
        if (!req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) return res.sendStatus(200);
        const message = req.body.entry[0].changes[0].value.messages[0];
        const senderPhone = message.from;
        const session = getSession(senderPhone);

        if (message.type === 'image') {
            if (session.step === 'awaitingSS') {
                session.step = 'awaitingName';
                await sendText(senderPhone, "SS mil gaya! Ab apna Full Name bhej dein:");
            } else if (session.tempSelection) {
                session.cart.push(session.tempSelection);
                session.tempSelection = null;
                await sendCheckoutMenu(senderPhone);
            }
            return res.sendStatus(200);
        }

        if (message.type === 'text') {
            if (session.step === 'awaitingName') {
                session.customerName = message.text.body;
                session.step = 'awaitingAddress';
                await sendText(senderPhone, "Name save ho gaya! Ab apna mukammal Address bhej dein:");
            } else if (session.step === 'awaitingAddress') {
                session.customerAddress = message.text.body;
                let totalBill = session.cart.reduce((sum, item) => sum + parseInt(item.price), 0);
                
                const newOrder = {
                    id: orderIdCounter++,
                    phone: senderPhone,
                    items: [...session.cart],
                    total: totalBill,
                    name: session.customerName,
                    address: session.customerAddress,
                    time: new Date().toLocaleString()
                };
                
                await saveOrderToSheet(newOrder);
                await sendText(senderPhone, "Aap ka order mukammal tor par confirm ho gaya ha! Admin jald he isay verify kar k dispatch kar de ga. Thrills say shopping karne ka bohat shukriya!");
                sessions[senderPhone] = { cart: [], tempSelection: null, step: 'start', customerDetails: '', customerName: '', customerAddress: '' };
            } else {
                await sendDynamicMainMenu(senderPhone);
            }
            return res.sendStatus(200);
        }

        if (message.type === 'interactive') {
            const replyId = (message.interactive.list_reply || message.interactive.button_reply).id;
            
            if (replyId.startsWith('cat')) {
                await sendDynamicSizes(senderPhone, replyId.split('cat')[1]);
            }
            else if (replyId.startsWith('size')) {
                const parts = replyId.split('size')[1].split('xx');
                await sendDynamicPrices(senderPhone, parts[0], parts[1]);
            }
            else if (replyId.startsWith('price')) {
                const parts = replyId.split('price')[1].split('xx');
                const rows = await getSheetData();
                
                const matchedRow = rows.find(r => 
                    r[0] && r[0].toLowerCase().trim() === parts[0].toLowerCase().trim() && 
                    r[1] && r[1].toLowerCase().trim() === parts[1].toLowerCase().trim() && 
                    r[2] && r[2].toLowerCase().trim() === parts[2].toLowerCase().trim()
                );
                
                if (matchedRow) {
                    session.tempSelection = { item: matchedRow[0], size: matchedRow[1], price: matchedRow[2] };
                    await sendVideo(senderPhone, matchedRow[3]);
                } else {
                    await sendText(senderPhone, "Maazrat, yeh item available nahi ha. Dubara koshish karein.");
                    await sendDynamicMainMenu(senderPhone);
                }
            }
            else if (replyId === 'checkout') {
                let billText = "Total Bill: " + session.cart.reduce((sum, item) => sum + parseInt(item.price), 0) + "\n\nEasypaisa: 03123123123\n\nSS bhejein:";
                session.step = 'awaitingSS';
                await sendText(senderPhone, billText);
            }
            else if (replyId === 'addmore') {
                await sendDynamicMainMenu(senderPhone);
            }
        }
    } catch (err) {
        console.error("Webhook Internal Error:", err);
    }
    res.sendStatus(200);
});

async function sendDynamicMainMenu(to) {
    const rows = await getSheetData();
    const categories = [...new Set(rows.map(r => r[0] ? r[0].trim() : ''))].filter(Boolean);
    if (categories.length === 0) return sendText(to, "Store mein abhi koi items nahi hain.");

    const listRows = categories.map(cat => ({ id: `cat${cat}`, title: cat }));
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONENUMBERID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "list", header: { type: "text", text: "Thrills Store" },
                body: { text: "Kia dekhna pasand karein gay?" },
                footer: { text: "Menu" },
                action: { button: "Categories", sections: [{ title: "Items", rows: listRows }] }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` } });
    } catch (e) { console.error(e.message); }
}

async function sendDynamicSizes(to, category) {
    const rows = await getSheetData();
    const sizes = [...new Set(rows.filter(r => r[0] && r[0].toLowerCase().trim() === category.toLowerCase().trim()).map(r => r[1] ? r[1].trim() : ''))].filter(Boolean);
    const listRows = sizes.map(size => ({ id: `size${category}xx${size}`, title: size }));

    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONENUMBERID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "list", header: { type: "text", text: "Size Select Karein" },
                body: { text: `Aap nay ${category} select kia ha. Apna size batayein:` },
                footer: { text: "Thrills Store" },
                action: { button: "Sizes", sections: [{ title: "Available Sizes", rows: listRows }] }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` } });
    } catch (e) { console.error(e.message); }
}

async function sendDynamicPrices(to, category, size) {
    const rows = await getSheetData();
    const prices = [...new Set(rows.filter(r => 
        r[0] && r[0].toLowerCase().trim() === category.toLowerCase().trim() && 
        r[1] && r[1].toLowerCase().trim() === size.toLowerCase().trim()
    ).map(r => r[2] ? r[2].trim() : ''))].filter(Boolean);
    
    const listRows = prices.map(price => ({ id: `price${category}xx${size}xx${price}`, title: `Rs ${price}` }));

    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONENUMBERID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "list", header: { type: "text", text: "Price Select Karein" },
                body: { text: `Price select karein ta k hum video bhej sakein:` },
                footer: { text: "Thrills Store" },
                action: { button: "Prices", sections: [{ title: "Available Prices", rows: listRows }] }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` } });
    } catch (e) { console.error(e.message); }
}

async function sendCheckoutMenu(to) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONENUMBERID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "button", body: { text: "Item pasand karne ka shukriya. Kuch aur dekhna chahtay hain ya checkout kar k bill banwaein?" },
                action: {
                    buttons: [
                        { type: "reply", reply: { id: "addmore", title: "Add More Items" } },
                        { type: "reply", reply: { id: "checkout", title: "Checkout" } }
                    ]
                }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` } });
    } catch (e) { console.error(e.message); }
}

async function sendVideo(to, url) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONENUMBERID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "video", video: { link: url }
        }, { headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` } });
    } catch (e) { await sendText(to, `Video Link: ${url}`); }
}

async function sendText(to, text) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONENUMBERID}/messages`, {
            messaging_product: "whatsapp", to: to, text: { body: text }
        }, { headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` } });
    } catch (e) {}
}

app.listen(PORT, () => console.log(`Server live`));