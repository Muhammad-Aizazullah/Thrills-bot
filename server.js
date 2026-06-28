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

    // Image Handle (Screenshots)
    if (message.type === 'image') {
        if (session.step === 'awaiting_ss') {
            session.step = 'awaiting_address';
            await sendText(senderPhone, "Bohat shukriya! Aap ka payment screenshot receive ho gaya ha. Ab kindly apna Full Name aur mukammal Address yahan text kar k bhejein ta k order dispatch kiya ja sakay.");
        } 
        else if (session.tempSelection) {
            session.cart.push(session.tempSelection);
            session.tempSelection = null;
            session.step = 'cart_options';
            await sendCheckoutMenu(senderPhone);
        } else {
            await sendText(senderPhone, "Pehlay menu say koi item select karein phir screenshot bhejein.");
            await sendDynamicMainMenu(senderPhone);
        }
        return res.sendStatus(200);
    }

    // Text Handle (Greeting & Address)
    if (message.type === 'text') {
        if (session.step === 'awaiting_address') {
            session.customerDetails = message.text.body;
            let totalBill = session.cart.reduce((sum, item) => sum + parseInt(item.price), 0);
            
            const newOrder = {
                id: orderIdCounter++,
                phone: senderPhone,
                items: [...session.cart],
                total: totalBill,
                status: 'New',
                time: new Date().toLocaleString(),
                details: session.customerDetails
            };
            globalOrders.push(newOrder);

            await sendText(senderPhone, "Aap ka order mukammal tor par confirm ho gaya ha! Admin jald he isay verify kar k dispatch kar de ga. Thrills say shopping karne ka bohat shukriya!");
            
            // Cart aur session clear kar dein order anay k baad
            sessions[senderPhone] = { cart: [], tempSelection: null, step: 'start', customerDetails: '' };
        } else {
            await sendDynamicMainMenu(senderPhone);
        }
        return res.sendStatus(200);
    }

    // Button / List Replies Handle
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
            // Case-insensitive match ta k sizes/prices miss na hon
            const matchedRow = rows.find(r => 
                r[0] && r[0].toLowerCase().trim() === category.toLowerCase().trim() && 
                r[1] && r[1].toLowerCase().trim() === size.toLowerCase().trim() && 
                r[2] && r[2].toLowerCase().trim() === price.toLowerCase().trim()
            );
            
            if (matchedRow) {
                session.tempSelection = { item: matchedRow[0], size: matchedRow[1], price: matchedRow[2] };
                session.step = 'viewing';
                await sendVideo(senderPhone, matchedRow[3]);
            } else {
                await sendText(senderPhone, "Maazrat, is price mein item available nahi ha.");
                await sendDynamicMainMenu(senderPhone);
            }
        }
        else if (replyId === 'checkout') {
            if (session.cart.length === 0) {
                await sendText(senderPhone, "Aap ka cart khali ha.");
                return res.sendStatus(200);
            }

            let billText = "🛍️ *Aap Ka Total Bill* 🛍️\n\n";
            let total = 0;
            
            session.cart.forEach((c, index) => {
                billText += `${index + 1}. Item: ${c.item}\n   Size: ${c.size}\n   Price: Rs ${c.price}\n\n`;
                total += parseInt(c.price);
            });
            
            billText += `*Total Items:* ${session.cart.length}\n*Total Bill:* Rs ${total}\n\n💳 *Payment Details:*\nEasypaisa Account: 03123123123\n\nKindly is number par payment kar k **Screenshot** isi chat mein bhejein.`;
            
            session.step = 'awaiting_ss';
            await sendText(senderPhone, billText);
        }
        else if (replyId === 'add_more') {
            await sendDynamicMainMenu(senderPhone);
        }
    }
    res.sendStatus(200);
});

// Dynamic UI Functions
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
    const sizes = [...new Set(rows.filter(r => r[0] && r[0].toLowerCase().trim() === category.toLowerCase().trim()).map(r => r[1] ? r[1].trim() : ''))].filter(Boolean);
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
    const prices = [...new Set(rows.filter(r => 
        r[0] && r[0].toLowerCase().trim() === category.toLowerCase().trim() && 
        r[1] && r[1].toLowerCase().trim() === size.toLowerCase().trim()
    ).map(r => r[2] ? r[2].trim() : ''))].filter(Boolean);
    
    const listRows = prices.map(price => ({ id: `price_${category}_${size}_${price}`, title: `Rs ${price}` }));

    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "list", header: { type: "text", text: "Price Select Karein" },
                body: { text: `Price select karein ta k hum video bhej sakein:` },
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
                type: "button", body: { text: "Item pasand karne ka shukriya. Kuch aur dekhna chahtay hain ya checkout kar k bill banwaein?" },
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