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
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const sessions = {}; 
let globalOrders = [];
let orderIdCounter = 1001;

function getSession(phone) {
    if (!sessions[phone]) {
        sessions[phone] = { cart: [], tempSelection: null, step: 'start', customerDetails: '' };
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
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A2:D100', 
        });
        return response.data.values || [];
    } catch (error) {
        console.error("Google Sheet Fetch Error:", error.message);
        return [];
    }
}

app.get('/api/orders', (req, res) => res.json(globalOrders));

app.post('/api/orders/update', (req, res) => {
    const { id, status } = req.body;
    const orderIndex = globalOrders.findIndex(o => o.id === id);
    if (orderIndex > -1) {
        globalOrders[orderIndex].status = status;
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

app.post('/api/add-product', async (req, res) => {
    try {
        const { name, size, price, videoUrl } = req.body;
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A:D',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[name, size, price, videoUrl]] }
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error("Sheet Append Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    if (!req.body.object || !req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) return res.sendStatus(200);
    
    const message = req.body.entry[0].changes[0].value.messages[0];
    const senderPhone = message.from;
    const session = getSession(senderPhone);

    if (message.type === 'image') {
        if (session.step === 'checkout') {
            let details = message.image.caption || session.customerDetails || 'Details not provided';
            let totalBill = session.cart.reduce((sum, item) => sum + parseInt(item.price), 0);
            
            const newOrder = {
                id: orderIdCounter++,
                phone: senderPhone,
                items: [...session.cart],
                total: totalBill,
                status: 'New',
                time: new Date().toLocaleString(),
                details: details
            };
            globalOrders.push(newOrder);

            await sendText(senderPhone, "Bohat shukriya! Aap ka payment screenshot aur order details receive ho gai hain. Hum jald he aap ka order dispatch kar dein gay.");
            sessions[senderPhone] = null; 
        } else {
            if (session.tempSelection) {
                session.cart.push(session.tempSelection);
                session.tempSelection = null;
                session.step = 'cart_options';
                await sendCheckoutMenu(senderPhone);
            } else {
                await sendText(senderPhone, "Pehlay menu say koi item select karein phir screenshot bhejein.");
                await sendDynamicMainMenu(senderPhone);
            }
        }
        return res.sendStatus(200);
    }

    if (message.type === 'text') {
        if (session.step === 'checkout') {
            session.customerDetails = message.text.body;
            await sendText(senderPhone, "Aap ki details save ho gai hain. Ab kindly payment ka screenshot isi chat mein bhejein ta k order final ho sakay.");
        } else {
            await sendDynamicMainMenu(senderPhone);
        }
        return res.sendStatus(200);
    }

    if (message.type === 'interactive') {
        const interactiveObj = message.interactive.list_reply || message.interactive.button_reply;
        if (!interactiveObj) return res.sendStatus(200);
        
        const replyId = interactiveObj.id;

        if (replyId.startsWith('cat_')) {
            const category = replyId.split('_')[1];
            await sendDynamicSizes(senderPhone, category);
        } 
        else if (replyId.startsWith('size_')) {
            const parts = replyId.split('_');
            const category = parts[1];
            const size = parts[2];
            await sendDynamicPrices(senderPhone, category, size);
        }
        else if (replyId.startsWith('price_')) {
            const parts = replyId.split('_');
            const category = parts[1];
            const size = parts[2];
            const price = parts[3];
            
            const rows = await getSheetData();
            const matchedRow = rows.find(r => r[0].trim() === category && r[1].trim() === size && r[2].trim() === price);
            
            if (matchedRow) {
                session.tempSelection = { item: category, size: size, price: price };
                session.step = 'viewing';
                await sendVideo(senderPhone, matchedRow[3]);
            } else {
                await sendText(senderPhone, "Maazrat, is price mein item available nahi ha.");
                await sendDynamicMainMenu(senderPhone);
            }
        }
        else if (replyId === 'checkout') {
            if (session.cart.length === 0) return res.sendStatus(200);

            let billText = "Aap Ka Total Bill:\n\n";
            let total = 0;
            
            session.cart.forEach((c, index) => {
                billText += `${index + 1}. Item: ${c.item}\n   Size: ${c.size}\n   Price: Rs ${c.price}\n\n`;
                total += parseInt(c.price);
            });
            
            billText += `Total Items: ${session.cart.length}\nTotal Bill: Rs ${total}\n\nEasypaisa Account: 03123123123\n\nKindly is number par payment kar k screenshot bhejein. Agar aap nay apna Full Name aur Address nahi bheja, to wo bhi text mein likh kar bhej dein.`;
            
            session.step = 'checkout';
            await sendText(senderPhone, billText);
        }
        else if (replyId === 'add_more') {
            await sendDynamicMainMenu(senderPhone);
        }
    }
    res.sendStatus(200);
});

async function sendDynamicMainMenu(to) {
    const rows = await getSheetData();
    const categories = [...new Set(rows.map(r => r[0] ? r[0].trim() : ''))].filter(Boolean);
    if (categories.length === 0) return sendText(to, "Store mein abhi koi items nahi hain.");

    const listRows = categories.map(cat => ({ id: `cat_${cat}`, title: cat }));
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "list", header: { type: "text", text: "Thrills Store" },
                body: { text: "Kia dekhna pasand karein gay?" },
                footer: { text: "Menu" },
                action: { button: "Categories", sections: [{ title: "Items", rows: listRows }] }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (e) { console.error(e.message); }
}

async function sendDynamicSizes(to, category) {
    const rows = await getSheetData();
    const sizes = [...new Set(rows.filter(r => r[0].trim() === category).map(r => r[1] ? r[1].trim() : ''))].filter(Boolean);
    const listRows = sizes.map(size => ({ id: `size_${category}_${size}`, title: size }));

    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "list", header: { type: "text", text: "Size Select Karein" },
                body: { text: `Aap nay ${category} select kia ha. Apna size batayein:` },
                footer: { text: "Thrills Store" },
                action: { button: "Sizes", sections: [{ title: "Available Sizes", rows: listRows }] }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (e) { console.error(e.message); }
}

async function sendDynamicPrices(to, category, size) {
    const rows = await getSheetData();
    const prices = [...new Set(rows.filter(r => r[0].trim() === category && r[1].trim() === size).map(r => r[2] ? r[2].trim() : ''))].filter(Boolean);
    const listRows = prices.map(price => ({ id: `price_${category}_${size}_${price}`, title: `Rs ${price}` }));

    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "list", header: { type: "text", text: "Price Range" },
                body: { text: `Iski price select karein:` },
                footer: { text: "Thrills Store" },
                action: { button: "Prices", sections: [{ title: "Available Prices", rows: listRows }] }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (e) { console.error(e.message); }
}

async function sendCheckoutMenu(to) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "button", body: { text: "Item pasand karne ka shukriya. Kuch aur dekhna chahtay hain ya bill banwaein?" },
                action: {
                    buttons: [
                        { type: "reply", reply: { id: "add_more", title: "Add More Items" } },
                        { type: "reply", reply: { id: "checkout", title: "Checkout" } }
                    ]
                }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (e) { console.error(e.message); }
}

async function sendVideo(to, url) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "video", video: { link: url }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (e) { await sendText(to, `Video Link: ${url}`); }
}

async function sendText(to, text) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to: to, text: { body: text }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (e) {}
}

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));