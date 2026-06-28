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

const userCarts = {}; 
let globalOrders = [];
let orderIdCounter = 1001;

const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'], 
});

async function getSheetData() {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Sheet1!A2:D100', 
    });
    return response.data.values || [];
}

// API: Frontend ko orders dena
app.get('/api/orders', (req, res) => res.json(globalOrders));

// API: Order ka status update karna
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

// API: Naya product Google Sheet mein add karna
app.post('/api/add-product', async (req, res) => {
    try {
        const { name, size, price, videoUrl } = req.body;
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A:D',
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [[name, size, price, videoUrl]]
            }
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error("Sheet Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// WhatsApp Webhook setup
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
    
    if (!userCarts[senderPhone]) userCarts[senderPhone] = [];

    if (message.type === 'image') {
        const cart = userCarts[senderPhone];
        if (cart.length === 0) {
            await sendText(senderPhone, "Aap ka cart khali ha. Pehlay koi item select karein.");
            return res.sendStatus(200);
        }

        let totalBill = cart.reduce((sum, item) => sum + parseInt(item.price), 0);
        
        const newOrder = {
            id: orderIdCounter++,
            phone: senderPhone,
            items: [...cart],
            total: totalBill,
            status: 'New',
            time: new Date().toLocaleString()
        };
        globalOrders.push(newOrder);

        await sendText(senderPhone, "Aap ka payment screenshot aur order receive ho gaya ha! Hum jald he isay confirm kar k dispatch kar dein gay. Shukriya!");
        
        userCarts[senderPhone] = []; 
        return res.sendStatus(200);
    }

    if (message.type === 'text') {
        await sendDynamicMainMenu(senderPhone);
        return res.sendStatus(200);
    }

    if (message.type === 'interactive') {
        const replyId = message.interactive.list_reply?.id || message.interactive.button_reply?.id;

        if (replyId.startsWith('cat_')) {
            const category = replyId.split('_')[1];
            await sendDynamicSizes(senderPhone, category);
        } 
        else if (replyId.startsWith('size_')) {
            const parts = replyId.split('_');
            const category = parts[1];
            const size = parts[2];
            
            const rows = await getSheetData();
            const matchedRow = rows.find(r => r[0] === category && r[1] === size);
            
            if (matchedRow) {
                const price = matchedRow[2];
                const videoUrl = matchedRow[3];
                
                userCarts[senderPhone].push({ item: category, size: size, price: price });
                
                await sendText(senderPhone, `Item: ${category}\nSize: ${size}\nPrice: Rs ${price}\n\nVideo load ho rahi ha...`);
                await sendVideo(senderPhone, videoUrl);
                await sendCheckoutMenu(senderPhone);
            }
        }
        else if (replyId === 'checkout') {
            const cart = userCarts[senderPhone];
            if (cart.length === 0) return res.sendStatus(200);

            let billText = "Aap Ka Total Bill:\n\n";
            let total = 0;
            
            cart.forEach((c, index) => {
                billText += `${index + 1}. Item: ${c.item}\n   Size: ${c.size}\n   Price: Rs ${c.price}\n\n`;
                total += parseInt(c.price);
            });
            
            billText += `Total Items: ${cart.length}\nTotal Bill: Rs ${total}\n\nU can pay via Easypaisa or Jazzcash on this number 03xxxxxxxxx and then send the screenshot of your payment along with your full address here.`;
            
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
    const categories = [...new Set(rows.map(r => r[0]))].filter(Boolean);
    
    if (categories.length === 0) return sendText(to, "Store mein abhi koi items nahi hain.");

    const listRows = categories.map(cat => ({ id: `cat_${cat}`, title: cat }));
    
    await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
        messaging_product: "whatsapp", to: to, type: "interactive",
        interactive: {
            type: "list", header: { type: "text", text: "Welcome!" },
            body: { text: "Kia dekhna pasand karein gay?" },
            footer: { text: "Select an option" },
            action: { button: "Items Dekhein", sections: [{ title: "Categories", rows: listRows }] }
        }
    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
}

async function sendDynamicSizes(to, category) {
    const rows = await getSheetData();
    const sizes = [...new Set(rows.filter(r => r[0] === category).map(r => r[1]))].filter(Boolean);
    
    const listRows = sizes.map(size => ({ id: `size_${category}_${size}`, title: size }));

    await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
        messaging_product: "whatsapp", to: to, type: "interactive",
        interactive: {
            type: "list", header: { type: "text", text: "Select Size" },
            body: { text: `Apna size muntakhib karein:` },
            footer: { text: "Store" },
            action: { button: "Sizes", sections: [{ title: "Available Sizes", rows: listRows }] }
        }
    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
}

async function sendCheckoutMenu(to) {
    await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
        messaging_product: "whatsapp", to: to, type: "interactive",
        interactive: {
            type: "button", body: { text: "Kia aap mazeed items dekhna chahtay hain ya checkout karein gay?" },
            action: {
                buttons: [
                    { type: "reply", reply: { id: "add_more", title: "Add More Items" } },
                    { type: "reply", reply: { id: "checkout", title: "Checkout & Bill" } }
                ]
            }
        }
    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
}

async function sendVideo(to, url) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "video", video: { link: url }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (e) { await sendText(to, `Video Link: ${url}`); }
}

async function sendText(to, text) {
    await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
        messaging_product: "whatsapp", to: to, text: { body: text }
    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
}

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));