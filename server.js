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

// Google Sheets Authentication setup
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

// APIs for Admin Panel
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
            requestBody: {
                values: [[name, size, price, videoUrl]]
            }
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error("Sheet Append Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook Verification
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// Main Webhook Handler
app.post('/webhook', async (req, res) => {
    if (!req.body.object || !req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) return res.sendStatus(200);
    
    const message = req.body.entry[0].changes[0].value.messages[0];
    const senderPhone = message.from;
    
    if (!userCarts[senderPhone]) userCarts[senderPhone] = [];

    // 1. Handle Screenshot/Image Upload
    if (message.type === 'image') {
        const cart = userCarts[senderPhone];
        if (cart.length === 0) {
            await sendText(senderPhone, "Aap ka cart khali ha. Pehlay koi item select karein.");
            return res.sendStatus(200);
        }

        let totalBill = cart.reduce((sum, item) => sum + (parseInt(item.price) || 0), 0);
        
        const newOrder = {
            id: orderIdCounter++,
            phone: senderPhone,
            items: [...cart],
            total: totalBill,
            status: 'New',
            time: new Date().toLocaleString()
        };
        globalOrders.push(newOrder);

        await sendText(senderPhone, "Aap ka payment screenshot aur order receive ho gaya ha! Admin jald he aap ka order check kar k confirm karay ga. Shukriya!");
        
        userCarts[senderPhone] = []; 
        return res.sendStatus(200);
    }

    // 2. Handle Text Input (Greeting / Menu trigger)
    if (message.type === 'text') {
        await sendDynamicMainMenu(senderPhone);
        return res.sendStatus(200);
    }

    // 3. Handle Interactive Button / List Replies
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
            
            const rows = await getSheetData();
            // Case-insensitive matching to prevent errors
            const matchedRow = rows.find(r => r[0] && r[0].toLowerCase().trim() === category.toLowerCase().trim() && r[1] && r[1].toLowerCase().trim() === size.toLowerCase().trim());
            
            if (matchedRow) {
                const price = matchedRow[2];
                const videoUrl = matchedRow[3];
                
                userCarts[senderPhone].push({ item: matchedRow[0], size: matchedRow[1], price: price });
                
                await sendText(senderPhone, `Item: ${matchedRow[0]}\nSize: ${matchedRow[1]}\nPrice: Rs ${price}\n\nVideo load ho rahi ha, baraye meharbani intezar karein...`);
                await sendVideo(senderPhone, videoUrl);
                await sendCheckoutMenu(senderPhone);
            } else {
                await sendText(senderPhone, "Maazrat, is size mein koi product is waqt available nahi ha.");
                await sendDynamicMainMenu(senderPhone);
            }
        }
        else if (replyId === 'checkout') {
            const cart = userCarts[senderPhone];
            if (cart.length === 0) {
                await sendText(senderPhone, "Aap ka cart khali ha.");
                return res.sendStatus(200);
            }

            let billText = "🛍️ *Aap Ka Total Bill* 🛍️\n\n";
            let total = 0;
            
            cart.forEach((c, index) => {
                const itemPrice = parseInt(c.price) || 0;
                billText += `${index + 1}. Item: ${c.item}\n   Size: ${c.size}\n   Price: Rs ${itemPrice}\n\n`;
                total += itemPrice;
            });
            
            billText += `*Total Items:* ${cart.length}\n*Total Bill:* Rs ${total}\n\nU can pay via Easypaisa or Jazzcash on this number 03xxxxxxxxx and then send the screenshot of your payment along with your full name and address here.`;
            
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
    // Unique categories filter
    const categories = [...new Set(rows.map(r => r[0] ? r[0].trim() : ''))].filter(Boolean);
    
    if (categories.length === 0) {
        return sendText(to, "Thrills Store mein Khush Aamdeed! Maazrat, is waqt store mein koi items mojoud nahi hain.");
    }

    const listRows = categories.map(cat => ({ id: `cat_${cat.toLowerCase()}`, title: cat }));
    
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "list", header: { type: "text", text: "Thrills Store" },
                body: { text: "Thrills mein Khush Aamdeed! Aap kia dekhna pasand karein gay?" },
                footer: { text: "Neechay button par click kar k select karein" },
                action: { button: "Categories Dekhein", sections: [{ title: "Main Menu", rows: listRows }] }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (error) { console.error("Main Menu UI Error:", error.message); }
}

async function sendDynamicSizes(to, category) {
    const rows = await getSheetData();
    // Filter sizes belonging to the selected category
    const sizes = [...new Set(rows.filter(r => r[0] && r[0].toLowerCase().trim() === category.toLowerCase().trim()).map(r => r[1] ? r[1].trim() : ''))].filter(Boolean);
    
    if (sizes.length === 0) {
        await sendText(to, "Maazrat, is category k sizes is waqt available nahi hain.");
        return sendDynamicMainMenu(to);
    }

    const listRows = sizes.map(size => ({ id: `size_${category}_${size.toLowerCase()}`, title: size }));

    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "list", header: { type: "text", text: "Select Size" },
                body: { text: `Aap nay ${category.toUpperCase()} select ki ha. Apna size muntakhib karein:` },
                footer: { text: "Thrills Store" },
                action: { button: "Available Sizes", sections: [{ title: "Sizes", rows: listRows }] }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (error) { console.error("Size Menu UI Error:", error.message); }
}

async function sendCheckoutMenu(to) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "button", body: { text: "Kia aap mazeed items dekhna chahtay hain ya checkout kar k bill check karna chahtay hain?" },
                action: {
                    buttons: [
                        { type: "reply", reply: { id: "add_more", title: "Add More Items" } },
                        { type: "reply", reply: { id: "checkout", title: "Checkout & Bill" } }
                    ]
                }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (error) { console.error("Checkout Menu UI Error:", error.message); }
}

async function sendVideo(to, url) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "video", video: { link: url }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (e) { 
        console.error("Direct Video Link Error, sending link as text:", e.message);
        await sendText(to, `Video Link: ${url}`); 
    }
}

async function sendText(to, text) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to: to, text: { body: text }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (e) { console.error("Text delivery error:", e.message); }
}

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));